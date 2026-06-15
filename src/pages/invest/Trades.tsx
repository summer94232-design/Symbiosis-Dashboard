import { useState, useEffect, useRef, useMemo } from 'react'
import { addDoc, getDocs, updateDoc, deleteDoc } from 'firebase/firestore'
import { investDB } from '../../lib/firebase'
import { userCol, userDoc } from '../../lib/userDB'
import { calcFee, calcTax, isETF, calcMarginDebt, calcTradeTotal, calcPositions, aggregateMarginPositions, type DividendRecord } from '../../lib/calc'
import { fetchTrades, fetchDividends, invalidateTrades, invalidateCashflow } from '../../lib/investData'
// ✅ 1-2：共用模組（CSV 解析 / 股票字典 / UI 樣式）
import { parseCSVLine, toNum, toInt } from '../../lib/csv'
import { lookupStockName, cacheStockName, saveStockName } from '../../lib/stockDict'
import { card, inp, lbl, btn } from '../../ui/styles'
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
    marginRepay?: number   // 融資賣出償還的借款（本金＋利息）
}

const emptyTrade: Trade = {
    date: new Date().toISOString().split('T')[0],
    type: 'buy', code: '', name: '', price: 0, shares: 0, fee: 0, tax: 0, total: 0, note: '',
    isMargin: false, marginRatio: 0.6, marginAmount: 0, marginRepay: 0
}

const isOddLot = (shares: number) => shares > 0 && shares < 1000

export default function Trades() {
    const [trades, setTrades] = useState<Trade[]>([])
    // ✅ 2-5：防呆需要正確持股數（含配股攞薄），故一併載入除權息紀錄
    const [dividends, setDividends] = useState<DividendRecord[]>([])
    const [editingId, setEditingId] = useState<string | null>(null)
    const [form, setForm] = useState<Trade>(emptyTrade)
    const [loading, setLoading] = useState(false)
    const [lookingUp, setLookingUp] = useState(false)
    const [importing, setImporting] = useState(false)
    const [importResult, setImportResult] = useState<{ success: number; failed: number; skipped: number; duplicated: number } | null>(null)
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
        // ✅ 1-1：改走共用快取層（lib/investData）
        const [rawTrades, divs] = await Promise.all([
            fetchTrades<Trade>('desc'),
            fetchDividends<DividendRecord>('asc'),
        ])
        setDividends(divs)
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
            u.total = calcTradeTotal(u)
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

    const calcTotal = (f: Trade) => calcTradeTotal(f)

    const handleChange = <K extends keyof Trade>(key: K, value: Trade[K]) => {
        setForm(f => {
            const u = { ...f, [key]: value }
            if (['price', 'shares', 'type', 'code', 'marginRatio', 'isMargin', 'marginRepay'].includes(key)) {
                if (u.price && u.shares) {
                    u.fee = calcFee(u.price, u.shares)
                    u.tax = u.type === 'sell' ? calcTax(u.price, u.shares, u.code) : 0
                    if (u.type === 'buy' && u.isMargin) {
                        u.marginAmount = calcMarginDebt(u.price * u.shares, u.marginRatio || 0.6)
                    }
                }
            }
            u.total = calcTotal(u)
            return u
        })
    }

    // ── 防呆：現股賣出但該代號目前有融資部位 ──
    // 現股賣出不會歸還融資借款（aggregateMarginPositions 只處理 isMargin 交易），
    // 若使用者融資買進後賣出時忘了勾「融資」，維持率分母不會減少且永遠不歸零。
    const sellMarginWarning = useMemo(() => {
        if (form.type !== 'sell' || form.isMargin || !form.code) return null
        const pos = aggregateMarginPositions(trades).find(m => m.code === form.code)
        return pos && pos.shares > 0 ? pos : null
    }, [trades, form.type, form.isMargin, form.code])

    // ── 防呆（2-5）：賣出股數 > 目前持股 ──
    // calc.ts 對負持倉雖有歸零防呆，但超賣會讓該筆已實現損益用到錯誤均價，
    // 後續持倉/損益數字都會失真，故在表單即時警告、儲存前再次確認。
    // 持股數以 calcPositions（含配股攞薄）計算；編輯既有紀錄時先將該筆
    // 從計算基準中移除，避免同一筆賣出被重複扣除造成誤報。
    const oversellWarning = useMemo(() => {
        if (form.type !== 'sell' || !form.code || !form.shares) return null
        const baseTrades = editingId ? trades.filter(t => t.id !== editingId) : trades
        const { holdings } = calcPositions(baseTrades, dividends)
        const held = holdings[form.code]?.shares ?? 0
        return form.shares > held ? { held } : null
    }, [trades, dividends, form.type, form.code, form.shares, editingId])

    const handleSave = async () => {
        if (!form.code || !form.price || !form.shares) return
        // ── 防呆（2-5）：儲存前確認 ──
        if (oversellWarning) {
            const ok = confirm(`賣出股數（${form.shares.toLocaleString()}）超過 ${form.code} 目前持股（${oversellWarning.held.toLocaleString()} 股），已實現損益將用到錯誤均價。確定仍要儲存？`)
            if (!ok) return
        }
        if (form.type === 'sell' && form.isMargin && !(form.marginRepay && form.marginRepay > 0)) {
            const ok = confirm('融資賣出未填「融資償還金額」，可用現金將被高估（賣出淨入帳少扣了還款）。確定仍要儲存？')
            if (!ok) return
        }
        setLoading(true)
        if (form.name && form.code) {
            await saveStockName(form.code, form.name)
        }
        if (editingId) {
            await updateDoc(userDoc(investDB, 'trades', editingId), { ...form })
        } else {
            await addDoc(userCol(investDB, 'trades'), { ...form })
        }
        invalidateTrades()   // ✅ 1-1：寫入後清快取，其他頁面才會拿到最新資料
        setEditingId(null); setForm(emptyTrade); setLoading(false); setShowForm(false); setEditModal(false)
        load()
    }

    const handleEdit = (t: Trade) => {
        if (t.code && t.name) cacheStockName(t.code, t.name)
        // 已在 load() 正規化，直接使用
        setForm(t); setEditingId(t.id!); setEditModal(true)
    }
    const handleCancel = () => { setForm(emptyTrade); setEditingId(null); setShowForm(false); setEditModal(false) }
    const handleDelete = async (id: string) => {
        if (!confirm('確定要刪除？')) return
        await deleteDoc(userDoc(investDB, 'trades', id))
        invalidateTrades()   // ✅ 1-1：寫入後清快取
        load()
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
        let success = 0, failed = 0, skipped = 0, duplicated = 0

        // ── 重複偵測：以既有資料建 key 集合，命中者略過不寫入 ──
        //    交易 key = 日期|代號|類型|價格|股數；出入金 key = 日期|類型|金額|備註
        //    ⚠️ 同日同價同量的「真實重複交易」也會被當成重複，匯入結果會單獨顯示重複筆數供核對。
        const [existTradesSnap, existCashSnap] = await Promise.all([
            getDocs(userCol(investDB, 'trades')),
            getDocs(userCol(investDB, 'cashflow')),
        ])
        const tradeKeys = new Set(existTradesSnap.docs.map(d => {
            const t = d.data()
            return `${t.date}|${t.code}|${t.type}|${Number(t.price)}|${Number(t.shares)}`
        }))
        const cashKeys = new Set(existCashSnap.docs.map(d => {
            const c = d.data()
            return `${c.date}|${c.type}|${Number(c.amount)}|${c.note || ''}`
        }))

        for (let i = 1; i < lines.length; i++) {
            const cols = parseCSVLine(lines[i])
            const row: Record<string, string> = {}
            headers.forEach((h, idx) => { row[h] = cols[idx] || '' })

            const type = row['類型']
            const date = row['日期']

            if (type === '入金' || type === '出金') {
                const amount = toNum(row['價格/金額'] || row['金額'] || '')
                if (amount > 0) {
                    const cashNote = row['備註/筆記'] || row['備註'] || ''
                    const cashKey = `${date}|${type === '入金' ? 'in' : 'out'}|${Number(amount)}|${cashNote}`
                    if (cashKeys.has(cashKey)) { duplicated++; continue }
                    cashKeys.add(cashKey)
                    await addDoc(userCol(investDB, 'cashflow'), {
                        date,
                        type: type === '入金' ? 'in' : 'out',
                        amount,
                        note: cashNote
                    })
                    success++
                } else { skipped++ }
                continue
            }
            // 支援新舊格式：現貨買入/現貨賣出/融資買入/融資賣出/買進/賣出
            const validTypes = ['買入', '買進', '賣出', '現貨買入', '現貨賣出', '融資買入', '融資賣出']
            if (!validTypes.includes(type)) { skipped++; continue }

            const isMarginCSV = type === '融資買入' || type === '融資賣出'
            const tradeType = (type === '賣出' || type === '現貨賣出' || type === '融資賣出') ? 'sell' : 'buy'

            const rawCode = (row['代號'] || '').replace('.TW', '').replace('.tw', '').trim()
            const name = (row['名稱'] || '').trim()
            const price = toNum(row['價格/金額'] || row['價格'] || '')
            const shares = toInt(row['股數'])

            if (!rawCode || !price || !shares) { failed++; continue }

            const tradeKey = `${date}|${rawCode}|${tradeType}|${Number(price)}|${Number(shares)}`
            if (tradeKeys.has(tradeKey)) { duplicated++; continue }
            tradeKeys.add(tradeKey)

            const isSell = tradeType === 'sell'
            const fee = calcFee(price, shares)
            const tax = isSell ? calcTax(price, shares, rawCode) : 0
            // 若 CSV 含融資欄位（完整備份）則沿用，否則融資成數預設 0.6、償還金額 0。
            // ⚠️ 非備份來源的融資賣出無法得知償還金額（含利息），匯入後請逐筆補上「融資償還金額」。
            const marginRatioCSV = isMarginCSV
                ? (row['融資成數'] ? toNum(row['融資成數']) || 0.6 : 0.6)
                : 0
            const marginRepayCSV = isMarginCSV && isSell
                ? (row['融資償還金額'] ? toNum(row['融資償還金額']) : 0)
                : 0
            const totalRawCSV = row['收付金額'] ? toNum(row['收付金額']) : null
            const total = totalRawCSV !== null ? totalRawCSV : calcTradeTotal({
                type: tradeType, price, shares, fee, tax,
                isMargin: isMarginCSV, marginRatio: marginRatioCSV, marginRepay: marginRepayCSV
            })

            try {
                await addDoc(userCol(investDB, 'trades'), {
                    date, type: tradeType, code: rawCode, name, price, shares, fee, tax, total,
                    isMargin: isMarginCSV, marginRatio: marginRatioCSV, marginRepay: marginRepayCSV,
                    note: row['備註/筆記'] || row['備註'] || ''
                })
                // ★ CSV 匯入時同步寫入 stockDict（只寫有名稱的）
                if (name && rawCode) {
                    await saveStockName(rawCode, name)
                }
                success++
            } catch { failed++ }
        }

        // ✅ 1-1：匯入會寫入 trades 與 cashflow，兩種快取都要清
        invalidateTrades()
        invalidateCashflow()
        setImportResult({ success, failed, skipped, duplicated })
        setImporting(false); e.target.value = ''
        load()
    }

    const filtered = trades.filter(t =>
        !search || t.code.toLowerCase().includes(search.toLowerCase()) || t.name.includes(search)
    )

    const feeHint = () => isOddLot(form.shares) ? '（零股 6折，最低 1 元）' : '（6折自動計算）'
    const feeHintColor = isOddLot(form.shares) ? 'var(--c-warning)' : 'var(--c-accent)'

    return (
        <>
            {/* 編輯 Modal */}
            {editModal && (
                <div style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.65)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px' }}
                    onClick={e => { if (e.target === e.currentTarget) handleCancel() }}>
                    <div style={{ ...card, width: '100%', maxWidth: '720px', maxHeight: '90vh', overflowY: 'auto', position: 'relative' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
                            <div style={{ fontSize: '15px', fontWeight: 600, color: 'var(--c-text)', display: 'flex', alignItems: 'center', gap: '8px' }}>
                                ✏️ 編輯交易
                                {isOddLot(form.shares) && (
                                    <span style={{ fontSize: '11px', backgroundColor: 'rgba(245,166,35,0.15)', color: 'var(--c-warning)', padding: '2px 8px', borderRadius: '20px', fontWeight: 600 }}>零股</span>
                                )}
                            </div>
                            <button onClick={handleCancel} style={{ background: 'none', border: 'none', color: 'var(--c-muted)', cursor: 'pointer', padding: '4px' }}><X size={18} /></button>
                        </div>
                        <div className="trades-grid">
                            <div><label style={lbl}>日期</label><input type="date" style={inp} value={form.date} onChange={e => handleChange('date', e.target.value)} /></div>
                            <div><label style={lbl}>類型</label>
                                <select style={inp} value={form.type} onChange={e => handleChange('type', e.target.value as 'buy' | 'sell')}>
                                    <option value="buy">買入</option>
                                    <option value="sell">賣出</option>
                                </select>
                            </div>
                            <div>
                                <label style={lbl}>股票代號</label>
                                <input style={inp} placeholder="例：2330" value={form.code} onChange={e => handleCodeChange(e.target.value)} />
                            </div>
                            <div>
                                <label style={lbl}>股票名稱 {lookingUp && <span style={{ color: 'var(--c-muted)', fontSize: '10px' }}>查詢中...</span>}</label>
                                <input style={inp} placeholder="輸入代號後自動帶入" value={form.name} onChange={e => handleChange('name', e.target.value)} />
                            </div>
                            <div><label style={lbl}>價格</label><input type="number" style={inp} placeholder="0" value={form.price || ''} onChange={e => handleChange('price', parseFloat(e.target.value) || 0)} /></div>
                            <div><label style={lbl}>股數</label><input type="number" style={inp} placeholder="0" value={form.shares || ''} onChange={e => handleChange('shares', parseInt(e.target.value) || 0)} /></div>
                            <div>
                                <label style={lbl}>手續費 <span style={{ color: feeHintColor, fontSize: '11px' }}>{feeHint()}</span></label>
                                <input type="number" style={inp} value={form.fee || ''} onChange={e => handleChange('fee', parseFloat(e.target.value) || 0)} />
                            </div>
                            <div>
                                <label style={lbl}>交易稅 <span style={{ color: form.type === 'sell' ? (isETF(form.code) ? 'var(--c-warning)' : 'var(--c-accent)') : 'var(--c-border)', fontSize: '11px' }}>
                                    {form.type === 'sell' ? (isETF(form.code) ? '（ETF千分之一）' : '（千分之三）') : '（買入免稅）'}
                                </span></label>
                                <input type="number" style={inp} value={form.tax || ''} onChange={e => handleChange('tax', parseFloat(e.target.value) || 0)} />
                            </div>
                            <div>
                                <label style={lbl}>收付金額 {form.isMargin && form.type === 'buy' && <span style={{ color: 'var(--c-warning)', fontSize: '11px' }}>（自備款）</span>}{form.isMargin && form.type === 'sell' && <span style={{ color: 'var(--c-positive)', fontSize: '11px' }}>（已扣償還）</span>}</label>
                                <input type="number" style={{ ...inp, color: form.type === 'buy' ? 'var(--c-danger)' : 'var(--c-positive)' }} value={form.total} readOnly />
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
                                                backgroundColor: form.isMargin ? 'rgba(245,166,35,0.9)' : 'var(--c-border)',
                                                transition: 'background-color 0.2s'
                                            }}>
                                            <div style={{
                                                position: 'absolute', top: '3px', left: form.isMargin ? '19px' : '3px',
                                                width: '16px', height: '16px', borderRadius: '50%', backgroundColor: '#fff',
                                                transition: 'left 0.2s'
                                            }} />
                                        </div>
                                        <span style={{ fontSize: '12px', color: form.isMargin ? 'var(--c-warning)' : 'var(--c-muted)', fontWeight: form.isMargin ? 600 : 400 }}>融資</span>
                                    </label>
                                </div>
                            </div>
                            {form.isMargin && form.type === 'buy' && (
                                <>
                                    <div>
                                        <label style={lbl}>融資成數 <span style={{ color: 'var(--c-warning)', fontSize: '11px' }}>（例：0.6 = 六成）</span></label>
                                        <input type="number" step="0.1" min="0" max="1" style={inp} value={form.marginRatio || 0.6} onChange={e => handleChange('marginRatio', parseFloat(e.target.value) || 0.6)} />
                                    </div>
                                    <div>
                                        <label style={lbl}>融資金額 <span style={{ color: 'var(--c-warning)', fontSize: '11px' }}>（自動計算）</span></label>
                                        <input type="number" style={{ ...inp, color: 'var(--c-warning)' }} value={form.marginAmount ?? 0} readOnly />
                                    </div>
                                </>
                            )}
                            {form.isMargin && form.type === 'sell' && (
                                <div>
                                    <label style={lbl}>融資償還金額 <span style={{ color: 'var(--c-warning)', fontSize: '11px' }}>（含利息，依券商對帳單）</span></label>
                                    <input type="number" style={{ ...inp, color: 'var(--c-warning)' }} value={form.marginRepay || ''} onChange={e => handleChange('marginRepay', parseFloat(e.target.value) || 0)} />
                                </div>
                            )}
                            {oversellWarning && (
                                <div className="span2" style={{ backgroundColor: 'color-mix(in srgb, var(--c-danger) 10%, transparent)', border: '1px solid var(--c-danger)', borderRadius: '8px', padding: '10px 12px', fontSize: '12px', color: 'var(--c-danger)', lineHeight: 1.6 }}>
                                    ⚠️ 賣出股數（{form.shares.toLocaleString()}）超過 {form.code} 目前持股（{oversellWarning.held.toLocaleString()} 股）。
                                    超賣會讓已實現損益用到錯誤均價，請確認股數或先補登先前的買入紀錄。
                                </div>
                            )}
                            {sellMarginWarning && (
                                <div className="span2" style={{ backgroundColor: 'color-mix(in srgb, var(--c-warning) 10%, transparent)', border: '1px solid var(--c-warning)', borderRadius: '8px', padding: '10px 12px', fontSize: '12px', color: 'var(--c-warning)', lineHeight: 1.6 }}>
                                    ⚠️ {form.code} 目前有融資部位（{sellMarginWarning.shares.toLocaleString()} 股、借款約 {Math.round(sellMarginWarning.marginAmount).toLocaleString()} 元）。
                                    此筆為「現股賣出」，不會歸還融資借款；若實際是融資賣出，請開啟「融資」開關並填入償還金額，否則維持率與可用現金會失真。
                                </div>
                            )}
                        </div>
                        <div style={{ display: 'flex', gap: '8px', marginTop: '16px', justifyContent: 'flex-end' }}>
                            <button style={btn('var(--c-border)')} onClick={handleCancel}><X size={14} />取消</button>
                            <button style={btn('var(--c-accent)')} onClick={handleSave} disabled={loading}>
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
        .trade-table th { padding: 8px 10px; text-align: left; color: var(--c-muted); font-weight: 500; border-bottom: 1px solid var(--c-border); white-space: nowrap; }
        .trade-table td { padding: 10px; border-bottom: 1px solid var(--c-border); color: var(--c-text); white-space: nowrap; }
        .trade-table tr:hover td { background-color: rgba(79,142,247,0.04); }
        .trade-card { background: var(--c-bg); border-radius: 10px; padding: 12px 14px; border: 1px solid var(--c-border); margin-bottom: 8px; }
        .trade-card:active { border-color: var(--c-accent); }
      `}</style>

            <div style={{ padding: 'clamp(12px, 3vw, 32px)', maxWidth: '1600px', margin: '0 auto' }}>

                {/* 標題列 */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px', flexWrap: 'wrap', gap: '8px' }}>
                    <div>
                        <h1 style={{ fontSize: 'clamp(16px, 2.5vw, 22px)', fontWeight: 700, color: 'var(--c-text)', margin: 0 }}>買賣紀錄</h1>
                        <p style={{ fontSize: '12px', color: 'var(--c-muted)', margin: '2px 0 0' }}>共 {trades.length} 筆交易</p>
                    </div>
                    <div style={{ display: 'flex', gap: '8px' }}>
                        <label style={{ ...btn('var(--c-card)'), border: '1px solid var(--c-border)', cursor: 'pointer', fontSize: '12px', padding: '7px 10px' }}>
                            <Upload size={13} />{isMobile ? 'CSV' : importing ? '匯入中...' : '匯入歷史紀錄 CSV'}
                            <input ref={fileRef} type="file" accept=".csv" onChange={handleImportCSV} disabled={importing} style={{ display: 'none' }} />
                        </label>
                        <button style={{ ...btn('var(--c-accent)'), fontSize: '12px', padding: '7px 12px' }} onClick={() => { setForm(emptyTrade); setEditingId(null); setShowForm(v => !v) }}>
                            {showForm ? <X size={13} /> : <Check size={13} />}{showForm ? '收起' : '新增交易'}
                        </button>
                    </div>
                </div>

                {importResult && (
                    <div style={{ backgroundColor: 'rgba(0,200,150,0.08)', border: '1px solid rgba(0,200,150,0.25)', borderRadius: '10px', padding: '12px 16px', marginBottom: '12px', display: 'flex', gap: '20px', flexWrap: 'wrap' }}>
                        <div><span style={{ fontSize: '11px', color: 'var(--c-muted)' }}>成功匯入</span><div style={{ fontSize: '16px', fontWeight: 700, color: 'var(--c-positive)' }}>{importResult.success} 筆</div></div>
                        {importResult.failed > 0 && <div><span style={{ fontSize: '11px', color: 'var(--c-muted)' }}>失敗</span><div style={{ fontSize: '16px', fontWeight: 700, color: 'var(--c-danger)' }}>{importResult.failed} 筆</div></div>}
                        {importResult.skipped > 0 && <div><span style={{ fontSize: '11px', color: 'var(--c-muted)' }}>略過</span><div style={{ fontSize: '16px', fontWeight: 700, color: 'var(--c-muted)' }}>{importResult.skipped} 筆</div></div>}
                        {importResult.duplicated > 0 && <div><span style={{ fontSize: '11px', color: 'var(--c-muted)' }}>重複略過</span><div style={{ fontSize: '16px', fontWeight: 700, color: 'var(--c-warning)' }}>{importResult.duplicated} 筆</div></div>}
                    </div>
                )}

                {/* 表單 */}
                {showForm && (
                    <div style={{ ...card, marginBottom: '16px' }}>
                        <div style={{ fontSize: '14px', fontWeight: 600, color: 'var(--c-text)', marginBottom: '16px' }}>
                            {editingId ? '✏️ 編輯交易' : '➕ 新增交易'}
                            {isOddLot(form.shares) && (
                                <span style={{ marginLeft: '10px', fontSize: '11px', backgroundColor: 'rgba(245,166,35,0.15)', color: 'var(--c-warning)', padding: '2px 8px', borderRadius: '20px', fontWeight: 600 }}>
                                    零股交易
                                </span>
                            )}
                        </div>
                        <div className="trades-grid">
                            <div><label style={lbl}>日期</label><input type="date" style={inp} value={form.date} onChange={e => handleChange('date', e.target.value)} /></div>
                            <div><label style={lbl}>類型</label>
                                <select style={inp} value={form.type} onChange={e => handleChange('type', e.target.value as 'buy' | 'sell')}>
                                    <option value="buy">買入</option>
                                    <option value="sell">賣出</option>
                                </select>
                            </div>
                            <div>
                                <label style={lbl}>股票代號</label>
                                <input style={inp} placeholder="例：2330" value={form.code} onChange={e => handleCodeChange(e.target.value)} />
                            </div>
                            <div>
                                <label style={lbl}>股票名稱 {lookingUp && <span style={{ color: 'var(--c-muted)', fontSize: '10px' }}>查詢中...</span>}</label>
                                <input style={inp} placeholder="輸入代號後自動帶入" value={form.name} onChange={e => handleChange('name', e.target.value)} />
                            </div>
                            <div><label style={lbl}>價格</label><input type="number" style={inp} placeholder="0" value={form.price || ''} onChange={e => handleChange('price', parseFloat(e.target.value) || 0)} /></div>
                            <div><label style={lbl}>股數</label><input type="number" style={inp} placeholder="0" value={form.shares || ''} onChange={e => handleChange('shares', parseInt(e.target.value) || 0)} /></div>
                            <div>
                                <label style={lbl}>手續費 <span style={{ color: feeHintColor, fontSize: '11px' }}>{feeHint()}</span></label>
                                <input type="number" style={inp} value={form.fee || ''} onChange={e => handleChange('fee', parseFloat(e.target.value) || 0)} />
                            </div>
                            <div>
                                <label style={lbl}>交易稅 <span style={{ color: form.type === 'sell' ? (isETF(form.code) ? 'var(--c-warning)' : 'var(--c-accent)') : 'var(--c-border)', fontSize: '11px' }}>
                                    {form.type === 'sell' ? (isETF(form.code) ? '（ETF千分之一）' : '（千分之三）') : '（買入免稅）'}
                                </span></label>
                                <input type="number" style={inp} value={form.tax || ''} onChange={e => handleChange('tax', parseFloat(e.target.value) || 0)} />
                            </div>
                            <div>
                                <label style={lbl}>收付金額 {form.isMargin && form.type === 'buy' && <span style={{ color: 'var(--c-warning)', fontSize: '11px' }}>（自備款）</span>}{form.isMargin && form.type === 'sell' && <span style={{ color: 'var(--c-positive)', fontSize: '11px' }}>（已扣償還）</span>}</label>
                                <input type="number" style={{ ...inp, color: form.type === 'buy' ? 'var(--c-danger)' : 'var(--c-positive)' }} value={form.total} readOnly />
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
                                                backgroundColor: form.isMargin ? 'rgba(245,166,35,0.9)' : 'var(--c-border)',
                                                transition: 'background-color 0.2s'
                                            }}>
                                            <div style={{
                                                position: 'absolute', top: '3px', left: form.isMargin ? '19px' : '3px',
                                                width: '16px', height: '16px', borderRadius: '50%', backgroundColor: '#fff',
                                                transition: 'left 0.2s'
                                            }} />
                                        </div>
                                        <span style={{ fontSize: '12px', color: form.isMargin ? 'var(--c-warning)' : 'var(--c-muted)', fontWeight: form.isMargin ? 600 : 400 }}>融資</span>
                                    </label>
                                </div>
                            </div>
                            {form.isMargin && form.type === 'buy' && (
                                <>
                                    <div>
                                        <label style={lbl}>融資成數 <span style={{ color: 'var(--c-warning)', fontSize: '11px' }}>（例：0.6 = 六成）</span></label>
                                        <input type="number" step="0.1" min="0" max="1" style={inp} value={form.marginRatio || 0.6} onChange={e => handleChange('marginRatio', parseFloat(e.target.value) || 0.6)} />
                                    </div>
                                    <div>
                                        <label style={lbl}>融資金額 <span style={{ color: 'var(--c-warning)', fontSize: '11px' }}>（自動計算）</span></label>
                                        <input type="number" style={{ ...inp, color: 'var(--c-warning)' }} value={form.marginAmount ?? 0} readOnly />
                                    </div>
                                </>
                            )}
                            {form.isMargin && form.type === 'sell' && (
                                <div>
                                    <label style={lbl}>融資償還金額 <span style={{ color: 'var(--c-warning)', fontSize: '11px' }}>（含利息，依券商對帳單）</span></label>
                                    <input type="number" style={{ ...inp, color: 'var(--c-warning)' }} value={form.marginRepay || ''} onChange={e => handleChange('marginRepay', parseFloat(e.target.value) || 0)} />
                                </div>
                            )}
                            {oversellWarning && (
                                <div className="span2" style={{ backgroundColor: 'color-mix(in srgb, var(--c-danger) 10%, transparent)', border: '1px solid var(--c-danger)', borderRadius: '8px', padding: '10px 12px', fontSize: '12px', color: 'var(--c-danger)', lineHeight: 1.6 }}>
                                    ⚠️ 賣出股數（{form.shares.toLocaleString()}）超過 {form.code} 目前持股（{oversellWarning.held.toLocaleString()} 股）。
                                    超賣會讓已實現損益用到錯誤均價，請確認股數或先補登先前的買入紀錄。
                                </div>
                            )}
                            {sellMarginWarning && (
                                <div className="span2" style={{ backgroundColor: 'color-mix(in srgb, var(--c-warning) 10%, transparent)', border: '1px solid var(--c-warning)', borderRadius: '8px', padding: '10px 12px', fontSize: '12px', color: 'var(--c-warning)', lineHeight: 1.6 }}>
                                    ⚠️ {form.code} 目前有融資部位（{sellMarginWarning.shares.toLocaleString()} 股、借款約 {Math.round(sellMarginWarning.marginAmount).toLocaleString()} 元）。
                                    此筆為「現股賣出」，不會歸還融資借款；若實際是融資賣出，請開啟「融資」開關並填入償還金額，否則維持率與可用現金會失真。
                                </div>
                            )}
                        </div>
                        <div style={{ display: 'flex', gap: '8px', marginTop: '16px', justifyContent: 'flex-end' }}>
                            {editingId && <button style={btn('var(--c-border)')} onClick={handleCancel}><X size={14} />取消</button>}
                            <button style={btn('var(--c-accent)')} onClick={handleSave} disabled={loading}>
                                <Check size={14} />{loading ? '儲存中...' : editingId ? '確認更新' : '確認新增'}
                            </button>
                        </div>
                    </div>
                )}

                {/* 搜尋列 */}
                <div style={{ marginBottom: '12px', position: 'relative' }}>
                    <Search size={14} style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)', color: 'var(--c-muted)' }} />
                    <input style={{ ...inp, paddingLeft: '36px', backgroundColor: 'var(--c-sidebar)', border: '1px solid var(--c-border)' }}
                        placeholder="搜尋代號或名稱..." value={search} onChange={e => setSearch(e.target.value)} />
                </div>

                {/* 列表 */}
                <div style={card}>
                    {filtered.length === 0 ? (
                        <div style={{ textAlign: 'center', padding: '48px', color: 'var(--c-muted)' }}>
                            {search ? `找不到「${search}」相關紀錄` : '還沒有交易紀錄'}
                        </div>
                    ) : isMobile ? (
                        <div>
                            {filtered.map(trade => (
                                <div key={trade.id} className="trade-card">
                                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
                                        onClick={() => setExpandedId(expandedId === trade.id ? null : trade.id!)}>
                                        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flex: 1, minWidth: 0 }}>
                                            <span style={{ backgroundColor: trade.type === 'buy' ? 'rgba(255,87,87,0.15)' : 'color-mix(in srgb, var(--c-positive) 15%, transparent)', color: trade.type === 'buy' ? 'var(--c-danger)' : 'var(--c-positive)', padding: '2px 8px', borderRadius: '20px', fontSize: '11px', fontWeight: 600, flexShrink: 0 }}>
                                                {trade.type === 'buy' ? '買' : '賣'}
                                            </span>
                                            {trade.isMargin && (
                                                <span style={{ backgroundColor: 'rgba(245,166,35,0.15)', color: 'var(--c-warning)', padding: '1px 6px', borderRadius: '20px', fontSize: '10px', fontWeight: 600, flexShrink: 0 }}>融資</span>
                                            )}
                                            {isOddLot(trade.shares) && (
                                                <span style={{ backgroundColor: 'color-mix(in srgb, var(--c-warning) 12%, transparent)', color: 'var(--c-warning)', padding: '1px 6px', borderRadius: '20px', fontSize: '10px', fontWeight: 600, flexShrink: 0 }}>零股</span>
                                            )}
                                            <span style={{ color: 'var(--c-accent)', fontWeight: 700, fontSize: '14px', flexShrink: 0 }}>{trade.code}</span>
                                            <span style={{ color: 'var(--c-text)', fontSize: '13px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{trade.name}</span>
                                        </div>
                                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 }}>
                                            <span style={{ color: trade.type === 'buy' ? 'var(--c-danger)' : 'var(--c-positive)', fontWeight: 600, fontSize: '13px' }}>
                                                ${trade.total.toLocaleString()}
                                            </span>
                                            {expandedId === trade.id ? <ChevronUp size={14} color="var(--c-muted)" /> : <ChevronDown size={14} color="var(--c-muted)" />}
                                        </div>
                                    </div>
                                    {expandedId === trade.id && (
                                        <div style={{ marginTop: '10px', paddingTop: '10px', borderTop: '1px solid var(--c-border)' }}>
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
                                                        <div style={{ fontSize: '10px', color: 'var(--c-muted)' }}>{label}</div>
                                                        <div style={{ fontSize: '13px', color: 'var(--c-text)' }}>{value}</div>
                                                    </div>
                                                ))}
                                            </div>
                                            <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
                                                <button onClick={() => handleEdit(trade)} style={{ ...btn('var(--c-card)'), border: '1px solid var(--c-border)', fontSize: '12px', padding: '6px 12px' }}>
                                                    <Pencil size={12} />編輯
                                                </button>
                                                <button onClick={() => handleDelete(trade.id!)} style={{ ...btn('rgba(255,87,87,0.15)'), color: 'var(--c-danger)', fontSize: '12px', padding: '6px 12px' }}>
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
                                                    <span style={{ backgroundColor: trade.type === 'buy' ? 'rgba(255,87,87,0.15)' : 'color-mix(in srgb, var(--c-positive) 15%, transparent)', color: trade.type === 'buy' ? 'var(--c-danger)' : 'var(--c-positive)', padding: '2px 10px', borderRadius: '20px', fontSize: '12px', fontWeight: 600 }}>{trade.type === 'buy' ? '買入' : '賣出'}</span>
                                                    {trade.isMargin && <span style={{ backgroundColor: 'rgba(245,166,35,0.15)', color: 'var(--c-warning)', padding: '2px 6px', borderRadius: '20px', fontSize: '10px', fontWeight: 600 }}>融資</span>}
                                                    {isOddLot(trade.shares) && <span style={{ backgroundColor: 'color-mix(in srgb, var(--c-warning) 12%, transparent)', color: '#d3d3d3', padding: '2px 6px', borderRadius: '20px', fontSize: '10px', fontWeight: 600 }}>零股</span>}
                                                </div>
                                            </td>
                                            <td style={{ color: 'var(--c-accent)', fontWeight: 700 }}>{trade.code}</td>
                                            <td>{trade.name}</td>
                                            <td>{trade.price.toLocaleString()}</td>
                                            <td>{trade.shares.toLocaleString()}</td>
                                            <td>{trade.fee.toLocaleString()}</td>
                                            <td>{trade.tax.toLocaleString()}</td>
                                            <td style={{ color: trade.type === 'buy' ? 'var(--c-danger)' : 'var(--c-positive)', fontWeight: 600 }}>{trade.total.toLocaleString()}</td>
                                            <td style={{ color: 'var(--c-muted)' }}>{trade.note}</td>
                                            <td>
                                                <div style={{ display: 'flex', gap: '8px' }}>
                                                    <button onClick={() => handleEdit(trade)} style={{ background: 'none', border: 'none', color: 'var(--c-accent)', cursor: 'pointer' }}><Pencil size={15} /></button>
                                                    <button onClick={() => handleDelete(trade.id!)} style={{ background: 'none', border: 'none', color: 'var(--c-danger)', cursor: 'pointer' }}><Trash2 size={15} /></button>
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