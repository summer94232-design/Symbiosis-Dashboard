import { useState, useEffect } from 'react'
import { collection, getDocs, doc, setDoc, deleteDoc, orderBy, query, getDoc } from 'firebase/firestore'
import { investDB } from '../../lib/firebase'
import { userCol, userDoc, userDocNested } from '../../lib/userDB'
import { calcPositions, calcAvailableCash, type TradeRecord, type DividendRecord } from '../../lib/calc'
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts'
import { Save, Pencil, Trash2, Plus, X, Check, Zap, AlertTriangle } from 'lucide-react'

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

interface TooltipPayloadItem { name: string; value: number; color: string }
interface CustomTooltipProps { active?: boolean; payload?: TooltipPayloadItem[]; label?: string }

const CustomTooltip = ({ active, payload, label }: CustomTooltipProps) => {
    if (!active || !payload?.length) return null
    return (
        <div style={{ backgroundColor: '#21253a', border: '1px solid #2e3349', borderRadius: '8px', padding: '12px 16px' }}>
            <p style={{ color: '#8892a4', fontSize: '12px', margin: '0 0 8px' }}>{label}</p>
            {payload.map((p) => (
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
    const [missingPriceCodes, setMissingPriceCodes] = useState<string[]>([])

    const loadSnapshots = async () => {
        setLoading(true)
        const q = query(userCol(investDB, 'assetSnapshots'), orderBy('date', 'asc'))
        const snap = await getDocs(q)
        setSnapshots(snap.docs.map(d => d.data() as SnapshotRecord))
        setLoading(false)
    }

    useEffect(() => {
        const init = async () => { await loadSnapshots() }
        init()
    }, [])

    const calcMarketValue = (
        positions: Record<string, { code: string; shares: number; totalCost: number }>,
        savedPrices: Record<string, number>
    ): { marketValue: number; missing: string[] } => {
        let marketValue = 0
        const missing: string[] = []
        Object.values(positions).forEach(pos => {
            const price = savedPrices[pos.code]
            if (price !== undefined && price > 0) {
                marketValue += price * pos.shares
            } else {
                marketValue += pos.totalCost
                missing.push(pos.code)
            }
        })
        return { marketValue, missing }
    }

    const handleAutoFill = async () => {
        setAutoLoading(true)
        setMissingPriceCodes([])
        try {
            const [tradesSnap, cashSnap, dividendsSnap] = await Promise.all([
                getDocs(query(userCol(investDB, 'trades'), orderBy('date', 'asc'))),
                getDocs(userCol(investDB, 'cashflow')),
                getDocs(query(userCol(investDB, 'dividends'), orderBy('date', 'asc'))),
            ])
            const trades = tradesSnap.docs.map(d => d.data() as TradeRecord)
            const cashRecords = cashSnap.docs.map(d => d.data() as { type: string; amount: number })
            const dividends = dividendsSnap.docs.map(d => d.data() as DividendRecord)

            const { holdings: positions } = calcPositions(trades, dividends)

            const priceDoc = await getDoc(userDocNested(investDB, 'settings', 'lastPrices'))
            const savedPrices = (priceDoc.exists() ? priceDoc.data() : {}) as Record<string, number>

            const { marketValue, missing } = calcMarketValue(positions, savedPrices)
            setMissingPriceCodes(missing)

            const cash = calcAvailableCash(cashRecords, trades)

            // ✅ 修正：扣除融資借款（負債），呈現真實淨資產
            const totalMarginDebt = trades
                .filter(t => t.isMargin && t.type === 'buy')
                .reduce((s, t) => s + ((t as any).marginAmount ?? 0), 0)
            const totalMarginRepaid = trades
                .filter(t => t.isMargin && t.type === 'sell')
                .reduce((s, t) => {
                    // 賣出時按比例歸還（簡化：直接用 marginAmount 欄位若有，否則略）
                    return s + ((t as any).marginAmount ?? 0)
                }, 0)
            const netMarginDebt = Math.max(0, totalMarginDebt - totalMarginRepaid)
            const totalAssets = marketValue + cash - netMarginDebt

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
        setMissingPriceCodes([])
        try {
            const [tradesSnap, cashSnap, dividendsSnap] = await Promise.all([
                getDocs(query(userCol(investDB, 'trades'), orderBy('date', 'asc'))),
                getDocs(userCol(investDB, 'cashflow')),
                getDocs(query(userCol(investDB, 'dividends'), orderBy('date', 'asc'))),
            ])
            const trades = tradesSnap.docs.map(d => d.data() as TradeRecord)
            const cashRecords = cashSnap.docs.map(d => d.data() as { type: string; amount: number })
            const dividends = dividendsSnap.docs.map(d => d.data() as DividendRecord)

            const { holdings: positions } = calcPositions(trades, dividends)
            const priceDoc = await getDoc(userDocNested(investDB, 'settings', 'lastPrices'))
            const savedPrices = (priceDoc.exists() ? priceDoc.data() : {}) as Record<string, number>

            const { marketValue, missing } = calcMarketValue(positions, savedPrices)
            setMissingPriceCodes(missing)

            const cash = calcAvailableCash(cashRecords, trades)

            // ✅ 修正：扣除融資借款，呈現真實淨資產
            const totalMarginDebt = trades
                .filter(t => t.isMargin && t.type === 'buy')
                .reduce((s, t) => s + ((t as any).marginAmount ?? 0), 0)
            const totalMarginRepaid = trades
                .filter(t => t.isMargin && t.type === 'sell')
                .reduce((s, t) => s + ((t as any).marginAmount ?? 0), 0)
            const netMarginDebt = Math.max(0, totalMarginDebt - totalMarginRepaid)
            const totalAssets = marketValue + cash - netMarginDebt

            const today = new Date().toISOString().split('T')[0]

            await setDoc(userDoc(investDB, 'assetSnapshots', today), {
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
        await setDoc(userDoc(investDB, 'assetSnapshots', form.date), { ...form })
        setShowForm(false); setEditingDate(null); setForm(emptySnap)
        setMissingPriceCodes([])
        setFormLoading(false); loadSnapshots()
    }

    const handleEdit = (s: SnapshotRecord) => { setForm({ ...s }); setEditingDate(s.date); setShowForm(true) }
    const handleDelete = async (date: string) => {
        if (!confirm(`確定要刪除 ${date} 的紀錄？`)) return
        await deleteDoc(userDoc(investDB, 'assetSnapshots', date)); loadSnapshots()
    }
    const handleCancel = () => { setShowForm(false); setEditingDate(null); setForm(emptySnap); setMissingPriceCodes([]) }

    const filterByRange = (data: SnapshotRecord[]) => {
        if (range === 'ALL') return data
        const now = new Date()
        const months = range === '1M' ? 1 : range === '3M' ? 3 : range === '6M' ? 6 : 12
        const cutoff = new Date(now.getFullYear(), now.getMonth() - months, now.getDate()).toISOString().split('T')[0]
        return data.filter(d => d.date >= cutoff)
    }

    const filtered = filterByRange(snapshots)
    const latest = snapshots[snapshots.length - 1]

    // Y 軸範圍：依資料自動計算，不從 0 開始
    const yDomain = (() => {
        if (filtered.length < 2) return ['auto', 'auto'] as [string, string]
        const allValues = filtered.map(d => d.totalAssets)
        const minVal = Math.min(...allValues)
        const maxVal = Math.max(...allValues)
        const span = maxVal - minVal
        // 上下各留 10% 空間，最少留 5% of maxVal
        const padding = span * 0.1 || maxVal * 0.05
        // 向下/上取整到最近的「整萬」
        const step = 10000
        const yMin = Math.floor((minVal - padding) / step) * step
        const yMax = Math.ceil((maxVal + padding) / step) * step
        return [yMin, yMax] as [number, number]
    })()

    return (
        <>
            <style>{`
                @keyframes spin { from { transform: rotate(0deg) } to { transform: rotate(360deg) } }
                .snap-form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
                @media (max-width: 600px) { .snap-form-grid { grid-template-columns: 1fr; } }
            `}</style>
            <div style={{ padding: '24px', maxWidth: '900px', margin: '0 auto' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '24px', flexWrap: 'wrap', gap: '12px' }}>
                    <h2 style={{ fontSize: '20px', fontWeight: 700, color: '#e2e8f0', margin: 0 }}>資產趨勢</h2>
                    <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                        <button onClick={saveToday} disabled={saving} style={btn('#00c896')}>
                            <Save size={15} style={{ animation: saving ? 'spin 1s linear infinite' : 'none' }} />
                            {saving ? '儲存中...' : '儲存今日快照'}
                        </button>
                        <button onClick={() => { setShowForm(true); setEditingDate(null); setForm(emptySnap) }} style={btn('#4f8ef7')}>
                            <Plus size={15} />手動新增
                        </button>
                    </div>
                </div>

                {/* 最新數字摘要 */}
                {latest && (
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '12px', marginBottom: '24px' }}>
                        {[
                            { label: '總資產', value: latest.totalAssets, color: '#4f8ef7' },
                            { label: '股票市值', value: latest.marketValue, color: '#00c896' },
                            { label: '現金', value: latest.cash, color: '#f5a623' },
                        ].map(item => (
                            <div key={item.label} style={card}>
                                <div style={{ fontSize: '12px', color: '#8892a4', marginBottom: '6px' }}>{item.label}</div>
                                <div style={{ fontSize: '20px', fontWeight: 700, color: item.color }}>
                                    ${item.value.toLocaleString()}
                                </div>
                            </div>
                        ))}
                    </div>
                )}

                {/* 趨勢圖 */}
                <div style={{ ...card, marginBottom: '24px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px', flexWrap: 'wrap', gap: '8px' }}>
                        <span style={{ fontSize: '14px', fontWeight: 600, color: '#e2e8f0' }}>資產走勢圖</span>
                        <div style={{ display: 'flex', gap: '6px' }}>
                            {(['1M', '3M', '6M', '1Y', 'ALL'] as const).map(r => (
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
                                <YAxis
                                    domain={yDomain}
                                    tick={{ fill: '#8892a4', fontSize: 12 }}
                                    tickFormatter={v => `${(v / 10000).toFixed(0)}萬`}
                                    width={60}
                                />
                                <Tooltip content={<CustomTooltip />} />
                                <Line type="monotone" dataKey="totalAssets" name="總資產" stroke="#4f8ef7" strokeWidth={2.5} dot={false} activeDot={{ r: 5, fill: '#4f8ef7' }} />
                            </LineChart>
                        </ResponsiveContainer>
                    )}
                </div>

                {/* 新增 / 編輯表單 */}
                {showForm && (
                    <div style={{ ...card, marginBottom: '24px', border: '1px solid #4f8ef7' }}>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
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

                        {/* 無現價警示 */}
                        {missingPriceCodes.length > 0 && (
                            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', backgroundColor: 'rgba(245,166,35,0.1)', border: '1px solid rgba(245,166,35,0.3)', borderRadius: '8px', padding: '10px 14px', marginBottom: '16px', fontSize: '12px', color: '#f5a623' }}>
                                <AlertTriangle size={14} style={{ flexShrink: 0 }} />
                                無現價：{missingPriceCodes.join('、')} — 市值以成本替代，數字可能低估
                            </div>
                        )}

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
                                <Check size={14} />{formLoading ? '儲存中...' : editingDate ? '更新' : '新增'}
                            </button>
                        </div>
                    </div>
                )}

                {/* 歷史紀錄列表 */}
                <div style={card}>
                    <div style={{ fontSize: '14px', fontWeight: 600, color: '#e2e8f0', marginBottom: '16px' }}>歷史紀錄</div>
                    {snapshots.length === 0 ? (
                        <div style={{ textAlign: 'center', padding: '32px', color: '#8892a4' }}>還沒有任何快照，點「儲存今日快照」開始記錄</div>
                    ) : (
                        <div style={{ overflowX: 'auto' }}>
                            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '14px' }}>
                                <thead>
                                    <tr style={{ borderBottom: '1px solid #2e3349' }}>
                                        {['日期', '總資產', '股票市值', '現金', '操作'].map(h => (
                                            <th key={h} style={{ padding: '10px 12px', textAlign: 'left', color: '#8892a4', fontWeight: 500 }}>{h}</th>
                                        ))}
                                    </tr>
                                </thead>
                                <tbody>
                                    {[...snapshots].reverse().map((s) => (
                                        <tr key={s.date} style={{ borderBottom: '1px solid #2e3349' }}>
                                            <td style={{ padding: '12px', color: '#8892a4' }}>{s.date}</td>
                                            <td style={{ padding: '12px', color: '#4f8ef7', fontWeight: 600 }}>${s.totalAssets.toLocaleString()}</td>
                                            <td style={{ padding: '12px', color: '#00c896' }}>${s.marketValue.toLocaleString()}</td>
                                            <td style={{ padding: '12px', color: '#f5a623' }}>${s.cash.toLocaleString()}</td>
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