import { useState, useEffect } from 'react'
import { getDocs, setDoc, deleteDoc, updateDoc } from 'firebase/firestore'
import { investDB } from '../../lib/firebase'
import { userCol, userDoc, userDocNested } from '../../lib/userDB'
import { getHistoricalCandles } from '../../lib/fugle'
import {
    Plus, Trash2, RefreshCw, TrendingUp, Pencil, Check, X,
    FileText, LayoutGrid, Table2, Tag, ChevronDown, ChevronRight, Activity
} from 'lucide-react'
import { usePrices } from '../../PriceContext'

interface WatchItem {
    code: string
    name: string
    targetHigh?: number
    targetLow?: number
    note?: string
    currentPrice?: number
    addedAt: string
    group?: string
}

// MA 資料結構
interface MAData {
    ma5: number | null
    ma10: number | null
    ma20: number | null
}

const UNGROUPED = '未分類'
const card: React.CSSProperties = { backgroundColor: '#1a1d27', border: '1px solid #2e3349', borderRadius: '12px', padding: '20px' }
const inp: React.CSSProperties = { backgroundColor: '#0f1117', border: '1px solid #2e3349', borderRadius: '8px', padding: '8px 12px', color: '#e2e8f0', fontSize: '14px', width: '100%', outline: 'none', boxSizing: 'border-box' }
const lbl: React.CSSProperties = { fontSize: '12px', color: '#8892a4', display: 'block', marginBottom: '4px' }
const btn = (color: string): React.CSSProperties => ({ backgroundColor: color, border: 'none', borderRadius: '8px', padding: '8px 16px', color: '#fff', fontSize: '14px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px' })

// 計算簡單移動平均
function calcMA(closes: number[], period: number): number | null {
    if (closes.length < period) return null
    const slice = closes.slice(-period)
    return slice.reduce((s, v) => s + v, 0) / period
}

function DistanceBar({ current, target, type }: { current: number; target: number; type: 'high' | 'low' }) {
    const pct = ((target - current) / current * 100)
    const absPct = Math.abs(pct)
    const reached = type === 'high' ? current >= target : current <= target
    const near = !reached && absPct <= 10
    const barColor = reached ? (type === 'high' ? '#00c896' : '#ff5757') : near ? '#f5a623' : '#4f8ef7'
    const fill = Math.min(100, type === 'high' ? (current / target) * 100 : (target / current) * 100)
    const sign = pct > 0 ? '+' : ''
    return (
        <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
                <span style={{ fontSize: '11px', color: '#8892a4' }}>{type === 'high' ? '上標' : '下標'} {target}</span>
                <span style={{ fontSize: '11px', fontWeight: 600, color: reached ? barColor : near ? '#f5a623' : '#8892a4' }}>
                    {reached ? '✓ 達標' : `${sign}${pct.toFixed(1)}%`}
                </span>
            </div>
            <div style={{ height: '5px', backgroundColor: '#2e3349', borderRadius: '3px', overflow: 'hidden' }}>
                <div style={{ height: '100%', width: `${fill}%`, backgroundColor: barColor, borderRadius: '3px', transition: 'width 0.4s ease' }} />
            </div>
        </div>
    )
}

function TargetCell({ current, target, type }: { current?: number; target: number; type: 'high' | 'low' }) {
    if (!current) return (
        <div>
            <span style={{ fontSize: '12px', fontWeight: 600, color: type === 'high' ? '#00c896' : '#ff5757' }}>{target}</span>
            <span style={{ fontSize: '10px', color: '#4a5568', marginLeft: '4px' }}>—</span>
        </div>
    )
    const pct = (target - current) / current * 100
    const reached = type === 'high' ? current >= target : current <= target
    const near = !reached && Math.abs(pct) <= 10
    const barColor = reached ? (type === 'high' ? '#00c896' : '#ff5757') : near ? '#f5a623' : '#3a4560'
    const textColor = reached ? barColor : near ? '#f5a623' : '#8892a4'
    const fill = Math.min(100, type === 'high' ? (current / target) * 100 : (target / current) * 100)
    return (
        <div style={{ minWidth: '90px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '6px' }}>
                <span style={{ fontSize: '12px', fontWeight: 600, color: type === 'high' ? '#00c896' : '#ff5757' }}>{target}</span>
                <span style={{ fontSize: '10px', fontWeight: 600, color: textColor }}>
                    {reached ? '✓' : `${pct > 0 ? '+' : ''}${pct.toFixed(1)}%`}
                </span>
            </div>
            <div style={{ height: '3px', backgroundColor: '#2e3349', borderRadius: '2px', marginTop: '3px', overflow: 'hidden' }}>
                <div style={{ height: '100%', width: `${fill}%`, backgroundColor: barColor, borderRadius: '2px' }} />
            </div>
        </div>
    )
}

// MA 標籤元件
function MABadge({ label, value, currentPrice }: { label: string; value: number | null; currentPrice?: number }) {
    if (value === null) return <span style={{ fontSize: '10px', color: '#3d4460' }}>{label}:—</span>
    const above = currentPrice ? currentPrice > value : null
    const color = above === null ? '#8892a4' : above ? '#00c896' : '#ff5757'
    return (
        <span style={{ fontSize: '10px', color, backgroundColor: `${color}15`, borderRadius: '4px', padding: '1px 5px', fontWeight: 600 }}>
            {label}:{value.toFixed(1)}
        </span>
    )
}

function TableRow({ item, ma, onEdit, onDelete }: {
    item: WatchItem; ma: MAData | null
    onEdit: (item: WatchItem) => void; onDelete: (code: string) => void
}) {
    const { code, name, currentPrice, targetHigh, targetLow, group } = item
    const reachedHigh = !!(currentPrice && targetHigh && currentPrice >= targetHigh)
    const reachedLow = !!(currentPrice && targetLow && currentPrice <= targetLow)
    const rowBg = reachedHigh ? 'rgba(0,200,150,0.06)' : reachedLow ? 'rgba(255,87,87,0.06)' : 'transparent'
    const leftBorder = reachedHigh ? '2px solid #00c896' : reachedLow ? '2px solid #ff5757' : '2px solid transparent'

    return (
        <tr style={{ backgroundColor: rowBg, borderBottom: '1px solid #1e2235' }}>
            <td style={{ padding: '6px 10px 6px 12px', whiteSpace: 'nowrap', borderLeft: leftBorder }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <span style={{ fontWeight: 700, color: '#4f8ef7', fontSize: '13px' }}>{code}</span>
                    <span style={{ fontSize: '11px', color: '#6b7690' }}>{name}</span>
                    {group && group !== UNGROUPED &&
                        <span style={{ fontSize: '10px', backgroundColor: 'rgba(79,142,247,0.12)', color: '#4f8ef7', borderRadius: '6px', padding: '0px 5px' }}>{group}</span>}
                </div>
            </td>
            <td style={{ padding: '6px 10px', textAlign: 'right', fontWeight: 700, fontSize: '13px', color: '#e2e8f0', whiteSpace: 'nowrap' }}>
                {currentPrice ? currentPrice.toFixed(2) : <span style={{ color: '#3a4560' }}>—</span>}
            </td>
            {/* MA 欄 */}
            <td style={{ padding: '6px 10px', whiteSpace: 'nowrap' }}>
                {ma ? (
                    <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
                        <MABadge label="5MA" value={ma.ma5} currentPrice={currentPrice} />
                        <MABadge label="10MA" value={ma.ma10} currentPrice={currentPrice} />
                        <MABadge label="20MA" value={ma.ma20} currentPrice={currentPrice} />
                    </div>
                ) : <span style={{ fontSize: '10px', color: '#3d4460' }}>—</span>}
            </td>
            <td style={{ padding: '6px 10px' }}>
                {targetLow ? <TargetCell current={currentPrice} target={targetLow} type="low" /> : <span style={{ fontSize: '11px', color: '#3a4560' }}>—</span>}
            </td>
            <td style={{ padding: '6px 10px' }}>
                {targetHigh ? <TargetCell current={currentPrice} target={targetHigh} type="high" /> : <span style={{ fontSize: '11px', color: '#3a4560' }}>—</span>}
            </td>
            <td style={{ padding: '6px 8px', textAlign: 'center', whiteSpace: 'nowrap' }}>
                <button onClick={() => onEdit(item)} style={{ background: 'none', border: 'none', color: '#3a4560', cursor: 'pointer', padding: '2px 3px' }}><Pencil size={11} /></button>
                <button onClick={() => onDelete(code)} style={{ background: 'none', border: 'none', color: '#3a4560', cursor: 'pointer', padding: '2px 3px' }}><Trash2 size={11} /></button>
            </td>
        </tr>
    )
}

// ── 主元件 ────────────────────────────────────────────────────────
export default function Watchlist() {
    // ── 全域現價 Context ──
    const { prices, lastUpdated, priceLoading, updatePrices: ctxUpdatePrices } = usePrices()

    const [items, setItems] = useState<WatchItem[]>([])
    const [loading, setLoading] = useState(true)
    const [showForm, setShowForm] = useState(false)
    const [editingCode, setEditingCode] = useState<string | null>(null)
    const [expandedNote, setExpandedNote] = useState<string | null>(null)
    const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set())
    const [stockDict, setStockDict] = useState<Record<string, string>>({})
    const [viewMode, setViewMode] = useState<'card' | 'table'>('card')
    const [filterGroup, setFilterGroup] = useState<string>('all')

    // MA 相關
    const [maData, setMaData] = useState<Record<string, MAData>>({})
    const [maLoading, setMaLoading] = useState(false)
    const [maUpdatedAt, setMaUpdatedAt] = useState('')

    const emptyForm = { code: '', name: '', targetHigh: '', targetLow: '', note: '', group: '' }
    const [form, setForm] = useState(emptyForm)

    const allGroups = Array.from(new Set(items.map(i => i.group || UNGROUPED))).sort()

    const load = async () => {
        setLoading(true)
        const snap = await getDocs(userCol(investDB, 'watchlist'))
        const data = snap.docs.map(d => ({ code: d.id, ...d.data() } as WatchItem))

        // 用 Context prices 填充現價（若有的話）
        data.forEach(item => {
            const ctxPrice = prices[item.code]
            if (ctxPrice !== null && ctxPrice !== undefined) {
                item.currentPrice = ctxPrice
            }
        })

        setItems(data.sort((a, b) => {
            const gA = a.group || UNGROUPED
            const gB = b.group || UNGROUPED
            return gA !== gB ? gA.localeCompare(gB) : a.code.localeCompare(b.code)
        }))

        const dictSnap = await getDocs(userCol(investDB, 'stockDict'))
        const dict: Record<string, string> = {}
        dictSnap.docs.forEach(d => { dict[d.id] = d.data().name })
        setStockDict(dict)
        setLoading(false)
    }

    useEffect(() => { load() }, [])

    // 當 Context prices 更新時，同步更新 items 現價
    useEffect(() => {
        if (Object.keys(prices).length === 0) return
        setItems(prev => prev.map(item => {
            const ctxPrice = prices[item.code]
            if (ctxPrice !== null && ctxPrice !== undefined) {
                return { ...item, currentPrice: ctxPrice }
            }
            return item
        }))
    }, [prices])

    // ★ 更新現價：委託 Context
    const handleUpdatePrices = async () => {
        const codes = items.map(i => i.code)
        if (codes.length === 0) return
        const quotes = await ctxUpdatePrices(codes)
        // items 會透過上面 useEffect 自動更新，也可以直接 setState
        setItems(prev => prev.map(item => ({
            ...item,
            currentPrice: quotes[item.code] ?? item.currentPrice
        })))
    }

    // ★ 更新 MA（5MA、10MA、20MA）
    const handleUpdateMA = async () => {
        const codes = items.map(i => i.code)
        if (codes.length === 0) return
        setMaLoading(true)
        try {
            // 取最近 30 個交易日的歷史資料以計算 20MA
            const to = new Date().toISOString().split('T')[0]
            const from = new Date(Date.now() - 45 * 86400000).toISOString().split('T')[0]

            const results: Record<string, MAData> = {}
            await Promise.all(codes.map(async code => {
                try {
                    const data = await getHistoricalCandles(code, from, to)
                    if (!data?.data?.length) { results[code] = { ma5: null, ma10: null, ma20: null }; return }
                    // Fugle historical candles 回傳格式：data.data 陣列，每項含 close
                    const closes: number[] = data.data
                        .filter((d: any) => d.close != null)
                        .map((d: any) => d.close)
                        .sort(() => 0) // 保持原排序（舊→新）
                    results[code] = {
                        ma5: calcMA(closes, 5),
                        ma10: calcMA(closes, 10),
                        ma20: calcMA(closes, 20),
                    }
                } catch {
                    results[code] = { ma5: null, ma10: null, ma20: null }
                }
            }))
            setMaData(results)
            setMaUpdatedAt(new Date().toLocaleString('zh-TW'))
        } catch (err) { console.error(err) }
        setMaLoading(false)
    }

    const handleAdd = async () => {
        if (!form.code.trim()) return
        const code = form.code.trim()
        const name = form.name.trim() || stockDict[code] || code
        await setDoc(userDoc(investDB, 'watchlist', code), {
            name,
            targetHigh: form.targetHigh ? parseFloat(form.targetHigh) : null,
            targetLow: form.targetLow ? parseFloat(form.targetLow) : null,
            note: form.note || null,
            group: form.group.trim() || null,
            addedAt: new Date().toISOString()
        })
        setForm(emptyForm); setShowForm(false); load()
    }

    const handleEdit = async (code: string) => {
        const item = items.find(i => i.code === code)
        if (!item) return
        await updateDoc(userDoc(investDB, 'watchlist', code), {
            targetHigh: form.targetHigh ? parseFloat(form.targetHigh) : null,
            targetLow: form.targetLow ? parseFloat(form.targetLow) : null,
            note: form.note || null,
            name: form.name || item.name,
            group: form.group.trim() || null,
        })
        setEditingCode(null); load()
    }

    const handleDelete = async (code: string) => {
        if (!confirm(`確定要從自選股移除 ${code}？`)) return
        await deleteDoc(userDoc(investDB, 'watchlist', code)); load()
    }

    const openEdit = (item: WatchItem) => {
        setEditingCode(item.code)
        setForm({ code: item.code, name: item.name, targetHigh: item.targetHigh?.toString() || '', targetLow: item.targetLow?.toString() || '', note: item.note || '', group: item.group || '' })
    }

    const toggleGroup = (g: string) => {
        setCollapsedGroups(prev => {
            const next = new Set(prev)
            next.has(g) ? next.delete(g) : next.add(g)
            return next
        })
    }

    const getPriceStatus = (item: WatchItem) => {
        if (!item.currentPrice) return 'normal'
        if (item.targetHigh && item.currentPrice >= item.targetHigh) return 'high'
        if (item.targetLow && item.currentPrice <= item.targetLow) return 'low'
        return 'normal'
    }

    const grouped: Record<string, WatchItem[]> = {}
    const filtered = filterGroup === 'all' ? items : items.filter(i => (i.group || UNGROUPED) === filterGroup)
    filtered.forEach(item => {
        const g = item.group || UNGROUPED
        if (!grouped[g]) grouped[g] = []
        grouped[g].push(item)
    })
    const groupKeys = Object.keys(grouped).sort()
    const alertCount = items.filter(i => getPriceStatus(i) !== 'normal').length

    return (
        <>
            <style>{`
                .watch-grid { display: grid; gap: 8px; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); }
                @media (max-width: 700px) { .watch-grid { grid-template-columns: 1fr; } }
                .form-grid { display: grid; gap: 12px; grid-template-columns: 1fr 1fr; }
                @media (max-width: 600px) { .form-grid { grid-template-columns: 1fr; } }
                @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
                .watch-card { transition: box-shadow 0.2s, border-color 0.2s; }
                .watch-card:hover { box-shadow: 0 4px 20px rgba(0,0,0,0.3); }
                .overview-table { width: 100%; border-collapse: collapse; }
                .overview-table thead th { position: sticky; top: 0; background: #12151f; z-index: 1; padding: 6px 10px; text-align: left; font-size: 11px; color: #6b7690; font-weight: 600; border-bottom: 1px solid #2e3349; letter-spacing: 0.03em; text-transform: uppercase; }
                .overview-table tbody tr:hover td { background-color: rgba(79,142,247,0.05) !important; }
            `}</style>

            <div style={{ padding: 'clamp(16px, 3vw, 32px)', maxWidth: '1400px', margin: '0 auto' }}>

                {/* 標題列 */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '20px', flexWrap: 'wrap', gap: '12px' }}>
                    <div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                            <h1 style={{ fontSize: 'clamp(18px, 2.5vw, 22px)', fontWeight: 700, color: '#e2e8f0', margin: 0 }}>自選股追蹤</h1>
                            {alertCount > 0 && (
                                <span style={{ fontSize: '12px', backgroundColor: 'rgba(245,166,35,0.2)', color: '#f5a623', borderRadius: '10px', padding: '2px 10px', fontWeight: 600 }}>
                                    🔔 {alertCount} 檔達標
                                </span>
                            )}
                        </div>
                        <p style={{ fontSize: '13px', color: '#8892a4', margin: '4px 0 0' }}>
                            {lastUpdated ? `現價更新：${lastUpdated}` : '點「更新現價」取得最新報價'}
                            {maUpdatedAt && <span style={{ marginLeft: '8px', color: '#a78bfa' }}>· MA 更新：{maUpdatedAt}</span>}
                        </p>
                    </div>
                    <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                        {/* 視圖切換 */}
                        <div style={{ display: 'flex', backgroundColor: '#12151f', borderRadius: '8px', padding: '3px', border: '1px solid #2e3349' }}>
                            <button onClick={() => setViewMode('card')} style={{ ...btn(viewMode === 'card' ? '#2e3349' : 'transparent'), padding: '5px 10px', fontSize: '12px', borderRadius: '6px' }}><LayoutGrid size={13} />卡片</button>
                            <button onClick={() => setViewMode('table')} style={{ ...btn(viewMode === 'table' ? '#2e3349' : 'transparent'), padding: '5px 10px', fontSize: '12px', borderRadius: '6px' }}><Table2 size={13} />一覽表</button>
                        </div>
                        {/* 更新 MA */}
                        <button onClick={handleUpdateMA} disabled={maLoading || items.length === 0} style={{ ...btn('#21253a'), border: '1px solid #2e3349' }}>
                            <Activity size={14} style={{ animation: maLoading ? 'spin 1s linear infinite' : 'none' }} />
                            {maLoading ? 'MA 計算中...' : '更新 MA'}
                        </button>
                        {/* 更新現價 */}
                        <button onClick={handleUpdatePrices} disabled={priceLoading || items.length === 0} style={btn('#21253a')}>
                            <RefreshCw size={14} style={{ animation: priceLoading ? 'spin 1s linear infinite' : 'none' }} />
                            {priceLoading ? '更新中...' : '更新現價'}
                        </button>
                        <button onClick={() => { setShowForm(!showForm); setForm(emptyForm) }} style={btn('#4f8ef7')}>
                            <Plus size={14} />{showForm ? '取消' : '新增自選股'}
                        </button>
                    </div>
                </div>

                {/* 族群篩選列 */}
                {allGroups.length > 1 && (
                    <div style={{ display: 'flex', gap: '8px', marginBottom: '16px', flexWrap: 'wrap', alignItems: 'center' }}>
                        <Tag size={13} style={{ color: '#8892a4', flexShrink: 0 }} />
                        {['all', ...allGroups].map(g => (
                            <button key={g} onClick={() => setFilterGroup(g)} style={{ ...btn(filterGroup === g ? '#4f8ef7' : '#21253a'), padding: '4px 12px', fontSize: '12px', borderRadius: '20px', border: `1px solid ${filterGroup === g ? '#4f8ef7' : '#2e3349'}` }}>
                                {g === 'all' ? `全部 (${items.length})` : `${g} (${items.filter(i => (i.group || UNGROUPED) === g).length})`}
                            </button>
                        ))}
                    </div>
                )}

                {/* 新增表單 */}
                {showForm && (
                    <div style={{ ...card, marginBottom: '20px' }}>
                        <div style={{ fontSize: '14px', fontWeight: 600, color: '#e2e8f0', marginBottom: '16px' }}>新增自選股</div>
                        <div className="form-grid">
                            <div>
                                <label style={lbl}>股票代號 *</label>
                                <input style={inp} placeholder="如：2330" value={form.code}
                                    onChange={e => { const code = e.target.value.toUpperCase(); setForm(f => ({ ...f, code, name: stockDict[code] || f.name })) }} />
                            </div>
                            <div>
                                <label style={lbl}>股票名稱</label>
                                <input style={inp} placeholder="自動帶入或手動輸入" value={form.name}
                                    onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />
                            </div>
                            <div>
                                <label style={lbl}>上標價（賣出參考）</label>
                                <input type="number" style={inp} placeholder="選填" value={form.targetHigh}
                                    onChange={e => setForm(f => ({ ...f, targetHigh: e.target.value }))} />
                            </div>
                            <div>
                                <label style={lbl}>下標價（買入參考）</label>
                                <input type="number" style={inp} placeholder="選填" value={form.targetLow}
                                    onChange={e => setForm(f => ({ ...f, targetLow: e.target.value }))} />
                            </div>
                            <div style={{ gridColumn: 'span 2' }}>
                                <label style={lbl}><Tag size={11} style={{ marginRight: '4px', verticalAlign: 'middle' }} />族群標籤</label>
                                <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '6px' }}>
                                    {allGroups.filter(g => g !== UNGROUPED).map(g => (
                                        <button key={g} onClick={() => setForm(f => ({ ...f, group: f.group === g ? '' : g }))}
                                            style={{ ...btn(form.group === g ? '#4f8ef7' : '#21253a'), padding: '3px 10px', fontSize: '12px', borderRadius: '20px', border: `1px solid ${form.group === g ? '#4f8ef7' : '#2e3349'}` }}>{g}</button>
                                    ))}
                                </div>
                                <input style={inp} placeholder="輸入新族群名稱，或選擇上方已有族群" value={form.group}
                                    onChange={e => setForm(f => ({ ...f, group: e.target.value }))} />
                            </div>
                            <div style={{ gridColumn: 'span 2' }}>
                                <label style={lbl}>評估筆記</label>
                                <textarea style={{ ...inp, minHeight: '60px', resize: 'vertical', fontFamily: 'sans-serif' }}
                                    placeholder="選填" value={form.note}
                                    onChange={e => setForm(f => ({ ...f, note: e.target.value }))} />
                            </div>
                        </div>
                        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '16px' }}>
                            <button style={btn('#2e3349')} onClick={() => { setShowForm(false); setForm(emptyForm) }}><X size={14} />取消</button>
                            <button style={btn('#4f8ef7')} onClick={handleAdd}><Check size={14} />新增</button>
                        </div>
                    </div>
                )}

                {/* 載入中 / 空狀態 */}
                {loading ? (
                    <div style={{ textAlign: 'center', padding: '60px', color: '#8892a4' }}>
                        <RefreshCw size={24} style={{ animation: 'spin 1s linear infinite', marginBottom: '12px' }} />
                        <p>載入中...</p>
                    </div>
                ) : items.length === 0 ? (
                    <div style={{ ...card, textAlign: 'center', padding: '60px' }}>
                        <TrendingUp size={32} color="#2e3349" style={{ marginBottom: '16px' }} />
                        <p style={{ color: '#8892a4', fontSize: '15px', margin: '0 0 8px' }}>尚無自選股</p>
                        <p style={{ color: '#3d4460', fontSize: '13px', margin: 0 }}>點擊「新增自選股」開始追蹤</p>
                    </div>
                ) : viewMode === 'table' ? (
                    /* ── 一覽表視圖 ── */
                    <div style={{ ...card, padding: '0', overflow: 'hidden' }}>
                        <div style={{ overflowX: 'auto', maxHeight: '70vh', overflowY: 'auto' }}>
                            <table className="overview-table">
                                <thead>
                                    <tr>
                                        <th>代號 / 名稱</th>
                                        <th style={{ textAlign: 'right' }}>現價</th>
                                        <th style={{ color: '#a78bfa' }}>均線 (5/10/20MA)</th>
                                        <th>下標（買入）</th>
                                        <th>上標（賣出）</th>
                                        <th style={{ textAlign: 'center' }}>操作</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {filtered.map(item => (
                                        <TableRow key={item.code} item={item} ma={maData[item.code] || null} onEdit={openEdit} onDelete={handleDelete} />
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </div>
                ) : (
                    /* ── 卡片視圖（依族群分組） ── */
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                        {groupKeys.map(groupName => {
                            const groupItems = grouped[groupName]
                            const isCollapsed = collapsedGroups.has(groupName)
                            return (
                                <div key={groupName}>
                                    {/* 族群標題 */}
                                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px', cursor: 'pointer' }} onClick={() => toggleGroup(groupName)}>
                                        {isCollapsed ? <ChevronRight size={14} color="#8892a4" /> : <ChevronDown size={14} color="#8892a4" />}
                                        <span style={{ fontSize: '13px', fontWeight: 600, color: groupName === UNGROUPED ? '#8892a4' : '#4f8ef7' }}>{groupName}</span>
                                        <span style={{ fontSize: '11px', color: '#3d4460' }}>{groupItems.length} 檔</span>
                                    </div>

                                    {!isCollapsed && (
                                        <div className="watch-grid">
                                            {groupItems.map(item => {
                                                const status = getPriceStatus(item)
                                                const isEditing = editingCode === item.code
                                                const borderColor = status === 'high' ? '#00c896' : status === 'low' ? '#ff5757' : '#2e3349'
                                                const ma = maData[item.code] || null

                                                return (
                                                    <div key={item.code} className="watch-card" style={{ backgroundColor: '#1a1d27', border: `1px solid ${borderColor}`, borderRadius: '10px', padding: '14px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                                                        {/* 第一行：代號 + 名稱 + 操作 */}
                                                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                                                            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flex: 1, minWidth: 0 }}>
                                                                <span style={{ fontWeight: 700, color: '#4f8ef7', fontSize: '14px' }}>{item.code}</span>
                                                                <span style={{ fontSize: '12px', color: '#6b7690', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.name}</span>
                                                            </div>
                                                            <div style={{ display: 'flex', gap: '4px', flexShrink: 0 }}>
                                                                <button onClick={() => openEdit(item)} style={{ background: 'none', border: 'none', color: '#3a4560', cursor: 'pointer', padding: '2px' }}><Pencil size={12} /></button>
                                                                <button onClick={() => handleDelete(item.code)} style={{ background: 'none', border: 'none', color: '#3a4560', cursor: 'pointer', padding: '2px' }}><Trash2 size={12} /></button>
                                                            </div>
                                                        </div>

                                                        {/* MA 行 */}
                                                        {ma && (
                                                            <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
                                                                <MABadge label="5MA" value={ma.ma5} currentPrice={item.currentPrice} />
                                                                <MABadge label="10MA" value={ma.ma10} currentPrice={item.currentPrice} />
                                                                <MABadge label="20MA" value={ma.ma20} currentPrice={item.currentPrice} />
                                                            </div>
                                                        )}

                                                        {/* 第二行：現價 + 目標價標籤 */}
                                                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                                            <span style={{ fontSize: '18px', fontWeight: 700, color: '#e2e8f0', lineHeight: 1 }}>
                                                                {item.currentPrice ? item.currentPrice.toFixed(2) : <span style={{ fontSize: '13px', color: '#4a5568' }}>—</span>}
                                                            </span>
                                                            <div style={{ display: 'flex', gap: '4px', marginLeft: 'auto' }}>
                                                                {item.targetLow && (
                                                                    <span style={{ fontSize: '11px', color: '#ff5757', backgroundColor: 'rgba(255,87,87,0.08)', borderRadius: '6px', padding: '1px 6px' }}>
                                                                        ↓{item.targetLow}
                                                                        {item.currentPrice && <span style={{ color: '#8892a4', marginLeft: '2px' }}>({((item.targetLow - item.currentPrice) / item.currentPrice * 100).toFixed(1)}%)</span>}
                                                                    </span>
                                                                )}
                                                                {item.targetHigh && (
                                                                    <span style={{ fontSize: '11px', color: '#00c896', backgroundColor: 'rgba(0,200,150,0.08)', borderRadius: '6px', padding: '1px 6px' }}>
                                                                        ↑{item.targetHigh}
                                                                        {item.currentPrice && <span style={{ color: '#8892a4', marginLeft: '2px' }}>({((item.targetHigh - item.currentPrice) / item.currentPrice * 100).toFixed(1)}%)</span>}
                                                                    </span>
                                                                )}
                                                            </div>
                                                        </div>

                                                        {/* 進度條 */}
                                                        {item.currentPrice && (item.targetHigh || item.targetLow) && (
                                                            <div style={{ display: 'flex', gap: '6px' }}>
                                                                {item.targetHigh && <DistanceBar current={item.currentPrice} target={item.targetHigh} type="high" />}
                                                                {item.targetLow && <DistanceBar current={item.currentPrice} target={item.targetLow} type="low" />}
                                                            </div>
                                                        )}

                                                        {/* 編輯模式 */}
                                                        {isEditing ? (
                                                            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                                                                <div style={{ display: 'flex', gap: '8px' }}>
                                                                    <div style={{ flex: 1 }}>
                                                                        <label style={lbl}>名稱</label>
                                                                        <input style={inp} value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />
                                                                    </div>
                                                                </div>
                                                                <div style={{ display: 'flex', gap: '8px' }}>
                                                                    <div style={{ flex: 1 }}>
                                                                        <label style={lbl}>上標價</label>
                                                                        <input type="number" style={inp} placeholder="賣出參考" value={form.targetHigh}
                                                                            onChange={e => setForm(f => ({ ...f, targetHigh: e.target.value }))} />
                                                                    </div>
                                                                    <div style={{ flex: 1 }}>
                                                                        <label style={lbl}>下標價</label>
                                                                        <input type="number" style={inp} placeholder="買入參考" value={form.targetLow}
                                                                            onChange={e => setForm(f => ({ ...f, targetLow: e.target.value }))} />
                                                                    </div>
                                                                </div>
                                                                <div>
                                                                    <label style={lbl}><Tag size={10} style={{ marginRight: '3px', verticalAlign: 'middle' }} />族群</label>
                                                                    <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginBottom: '6px' }}>
                                                                        {allGroups.filter(g => g !== UNGROUPED).map(g => (
                                                                            <button key={g} onClick={() => setForm(f => ({ ...f, group: f.group === g ? '' : g }))}
                                                                                style={{ ...btn(form.group === g ? '#4f8ef7' : '#21253a'), padding: '2px 8px', fontSize: '11px', borderRadius: '20px', border: `1px solid ${form.group === g ? '#4f8ef7' : '#2e3349'}` }}>{g}</button>
                                                                        ))}
                                                                    </div>
                                                                    <input style={inp} placeholder="族群名稱" value={form.group}
                                                                        onChange={e => setForm(f => ({ ...f, group: e.target.value }))} />
                                                                </div>
                                                                <div>
                                                                    <label style={lbl}>評估筆記</label>
                                                                    <textarea style={{ ...inp, minHeight: '60px', resize: 'vertical', fontFamily: 'sans-serif' }}
                                                                        value={form.note} onChange={e => setForm(f => ({ ...f, note: e.target.value }))} />
                                                                </div>
                                                                <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
                                                                    <button style={{ ...btn('#2e3349'), fontSize: '12px', padding: '6px 12px' }} onClick={() => setEditingCode(null)}><X size={12} />取消</button>
                                                                    <button style={{ ...btn('#4f8ef7'), fontSize: '12px', padding: '6px 12px' }} onClick={() => handleEdit(item.code)}><Check size={12} />儲存</button>
                                                                </div>
                                                            </div>
                                                        ) : (
                                                            <>
                                                                {item.note && (
                                                                    <div style={{ borderTop: '1px solid #2e3349', paddingTop: '6px', marginTop: '2px' }}>
                                                                        <button onClick={() => setExpandedNote(expandedNote === item.code ? null : item.code)}
                                                                            style={{ display: 'flex', alignItems: 'center', gap: '4px', background: 'none', border: 'none', color: '#4a5568', cursor: 'pointer', fontSize: '11px', padding: 0 }}>
                                                                            <FileText size={11} />筆記
                                                                            {expandedNote === item.code ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
                                                                        </button>
                                                                        {expandedNote === item.code && (
                                                                            <p style={{ fontSize: '11px', color: '#8892a4', margin: '4px 0 0', lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>{item.note}</p>
                                                                        )}
                                                                    </div>
                                                                )}
                                                            </>
                                                        )}
                                                    </div>
                                                )
                                            })}
                                        </div>
                                    )}
                                </div>
                            )
                        })}
                    </div>
                )}
            </div>
        </>
    )
}