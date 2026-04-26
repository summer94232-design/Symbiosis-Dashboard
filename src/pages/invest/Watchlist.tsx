import { useState, useEffect } from 'react'
import { getDocs, setDoc, deleteDoc, updateDoc } from 'firebase/firestore'
import { investDB } from '../../lib/firebase'
import { userCol, userDoc, userDocNested } from '../../lib/userDB'
import { getMultipleQuotes } from '../../lib/fugle'
import {
    Plus, Trash2, RefreshCw, TrendingUp, Pencil, Check, X,
    FileText, LayoutGrid, Table2, Tag, ChevronDown, ChevronRight, FolderPlus
} from 'lucide-react'

interface WatchItem {
    code: string
    name: string
    targetHigh?: number
    targetLow?: number
    note?: string
    currentPrice?: number
    addedAt: string
    group?: string   // ← 新增族群欄位
}

const UNGROUPED = '未分類'

const card: React.CSSProperties = { backgroundColor: '#1a1d27', border: '1px solid #2e3349', borderRadius: '12px', padding: '20px' }
const inp: React.CSSProperties = { backgroundColor: '#0f1117', border: '1px solid #2e3349', borderRadius: '8px', padding: '8px 12px', color: '#e2e8f0', fontSize: '14px', width: '100%', outline: 'none', boxSizing: 'border-box' }
const lbl: React.CSSProperties = { fontSize: '12px', color: '#8892a4', display: 'block', marginBottom: '4px' }
const btn = (color: string): React.CSSProperties => ({ backgroundColor: color, border: 'none', borderRadius: '8px', padding: '8px 16px', color: '#fff', fontSize: '14px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px' })

// ── 距離目標的進度條顏色邏輯 ─────────────────────────────────────
// ratio = currentPrice / targetHigh (或 targetLow)
// 上標：ratio > 1 → 達標（綠），0.9~1 → 接近（黃），<0.9 → 偏遠（藍灰）
// 下標：ratio < 1 → 達標（紅），1~1.1 → 接近（橘），>1.1 → 偏遠（藍灰）

function DistanceBar({
    current, target, type
}: { current: number; target: number; type: 'high' | 'low' }) {
    const pct = ((target - current) / current * 100)
    const absPct = Math.abs(pct)
    const reached = type === 'high' ? current >= target : current <= target
    const near = !reached && absPct <= 10

    const barColor = reached
        ? (type === 'high' ? '#00c896' : '#ff5757')
        : near ? '#f5a623' : '#4f8ef7'

    // 進度條填滿度：以 current/target 比例表示，最大100%
    const fill = Math.min(100, type === 'high'
        ? (current / target) * 100
        : (target / current) * 100)

    const sign = pct > 0 ? '+' : ''

    return (
        <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
                <span style={{ fontSize: '11px', color: '#8892a4' }}>
                    {type === 'high' ? '上標' : '下標'} {target}
                </span>
                <span style={{
                    fontSize: '11px', fontWeight: 600,
                    color: reached ? barColor : near ? '#f5a623' : '#8892a4'
                }}>
                    {reached ? '✓ 達標' : `${sign}${pct.toFixed(1)}%`}
                </span>
            </div>
            <div style={{ height: '5px', backgroundColor: '#2e3349', borderRadius: '3px', overflow: 'hidden' }}>
                <div style={{ height: '100%', width: `${fill}%`, backgroundColor: barColor, borderRadius: '3px', transition: 'width 0.4s ease' }} />
            </div>
        </div>
    )
}

// ── 目標欄：價格 + 距離% + 迷你進度條 合一 ───────────────────────
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

// ── 一覽表視圖行 ──────────────────────────────────────────────────
function TableRow({ item, onEdit, onDelete }: {
    item: WatchItem
    onEdit: (item: WatchItem) => void
    onDelete: (code: string) => void
}) {
    const { code, name, currentPrice, targetHigh, targetLow, group } = item
    const reachedHigh = !!(currentPrice && targetHigh && currentPrice >= targetHigh)
    const reachedLow = !!(currentPrice && targetLow && currentPrice <= targetLow)
    const rowBg = reachedHigh ? 'rgba(0,200,150,0.06)' : reachedLow ? 'rgba(255,87,87,0.06)' : 'transparent'
    const leftBorder = reachedHigh ? '2px solid #00c896' : reachedLow ? '2px solid #ff5757' : '2px solid transparent'

    return (
        <tr style={{ backgroundColor: rowBg, borderBottom: '1px solid #1e2235' }}>
            {/* 代號 + 名稱（同一行） */}
            <td style={{ padding: '6px 10px 6px 12px', whiteSpace: 'nowrap', borderLeft: leftBorder }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <span style={{ fontWeight: 700, color: '#4f8ef7', fontSize: '13px' }}>{code}</span>
                    <span style={{ fontSize: '11px', color: '#6b7690' }}>{name}</span>
                    {group && group !== UNGROUPED &&
                        <span style={{ fontSize: '10px', backgroundColor: 'rgba(79,142,247,0.12)', color: '#4f8ef7', borderRadius: '6px', padding: '0px 5px' }}>{group}</span>}
                </div>
            </td>
            {/* 現價 */}
            <td style={{ padding: '6px 10px', textAlign: 'right', fontWeight: 700, fontSize: '13px', color: '#e2e8f0', whiteSpace: 'nowrap' }}>
                {currentPrice ? currentPrice.toFixed(2) : <span style={{ color: '#3a4560' }}>—</span>}
            </td>
            {/* 下標（買入）*/}
            <td style={{ padding: '6px 10px' }}>
                {targetLow
                    ? <TargetCell current={currentPrice} target={targetLow} type="low" />
                    : <span style={{ fontSize: '11px', color: '#3a4560' }}>—</span>}
            </td>
            {/* 上標（賣出）*/}
            <td style={{ padding: '6px 10px' }}>
                {targetHigh
                    ? <TargetCell current={currentPrice} target={targetHigh} type="high" />
                    : <span style={{ fontSize: '11px', color: '#3a4560' }}>—</span>}
            </td>
            {/* 操作 */}
            <td style={{ padding: '6px 8px', textAlign: 'center', whiteSpace: 'nowrap' }}>
                <button onClick={() => onEdit(item)} style={{ background: 'none', border: 'none', color: '#3a4560', cursor: 'pointer', padding: '2px 3px' }}><Pencil size={11} /></button>
                <button onClick={() => onDelete(code)} style={{ background: 'none', border: 'none', color: '#3a4560', cursor: 'pointer', padding: '2px 3px' }}><Trash2 size={11} /></button>
            </td>
        </tr>
    )
}

// ── 主元件 ────────────────────────────────────────────────────────
export default function Watchlist() {
    const [items, setItems] = useState<WatchItem[]>([])
    const [loading, setLoading] = useState(true)
    const [priceLoading, setPriceLoading] = useState(false)
    const [showForm, setShowForm] = useState(false)
    const [editingCode, setEditingCode] = useState<string | null>(null)
    const [expandedNote, setExpandedNote] = useState<string | null>(null)
    const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set())
    const [stockDict, setStockDict] = useState<Record<string, string>>({})
    const [lastUpdated, setLastUpdated] = useState('')
    const [viewMode, setViewMode] = useState<'card' | 'table'>('card')
    const [filterGroup, setFilterGroup] = useState<string>('all')
    const [groupInput, setGroupInput] = useState('')   // 管理族群名稱輸入

    const emptyForm = { code: '', name: '', targetHigh: '', targetLow: '', note: '', group: '' }
    const [form, setForm] = useState(emptyForm)

    // 所有已使用的族群列表
    const allGroups = Array.from(new Set(items.map(i => i.group || UNGROUPED))).sort()

    const load = async () => {
        setLoading(true)
        const snap = await getDocs(userCol(investDB, 'watchlist'))
        const data = snap.docs.map(d => ({ code: d.id, ...d.data() } as WatchItem))
        const priceSnap = await getDocs(userCol(investDB, 'settings'))
        const priceData = priceSnap.docs.find(d => d.id === 'watchlistPrices')?.data() || {}
        const savedAt = priceData._updatedAt || ''
        if (savedAt) setLastUpdated(savedAt)
        data.forEach(item => { item.currentPrice = priceData[item.code] ?? undefined })
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

    const updatePrices = async () => {
        if (items.length === 0) return
        setPriceLoading(true)
        try {
            const codes = items.map(i => i.code)
            const quotes = await getMultipleQuotes(codes)
            const now = new Date().toLocaleString('zh-TW')
            const watchlistPriceData: Record<string, any> = { _updatedAt: now }
            codes.forEach(c => { if (quotes[c] !== null) watchlistPriceData[c] = quotes[c] })
            const existingSnap = await getDocs(userCol(investDB, 'settings'))
            const existingPrices = existingSnap.docs.find(d => d.id === 'lastPrices')?.data() || {}
            const lastPriceData: Record<string, any> = { ...existingPrices, _updatedAt: now }
            codes.forEach(c => { if (quotes[c] !== null) lastPriceData[c] = quotes[c] })
            await Promise.all([
                setDoc(userDocNested(investDB, 'settings', 'watchlistPrices'), watchlistPriceData),
                setDoc(userDocNested(investDB, 'settings', 'lastPrices'), lastPriceData),
            ])
            setItems(prev => prev.map(item => ({ ...item, currentPrice: quotes[item.code] ?? item.currentPrice })))
            setLastUpdated(now)
        } catch (err) { console.error(err) }
        setPriceLoading(false)
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
        setForm(emptyForm)
        setShowForm(false); load()
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
        setForm({
            code: item.code, name: item.name,
            targetHigh: item.targetHigh?.toString() || '',
            targetLow: item.targetLow?.toString() || '',
            note: item.note || '',
            group: item.group || ''
        })
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

    // 依族群分組
    const grouped: Record<string, WatchItem[]> = {}
    const filtered = filterGroup === 'all' ? items : items.filter(i => (i.group || UNGROUPED) === filterGroup)
    filtered.forEach(item => {
        const g = item.group || UNGROUPED
        if (!grouped[g]) grouped[g] = []
        grouped[g].push(item)
    })
    const groupKeys = Object.keys(grouped).sort()

    // 達標提示數
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
                .tab-btn { background: none; border: none; cursor: pointer; padding: '6px 12px'; border-radius: '6px'; font-size: 13px; }
                .group-badge { font-size: 11px; border-radius: 10px; padding: 2px 8px; display: inline-block; }
            `}</style>

            <div style={{ padding: 'clamp(16px, 3vw, 32px)', maxWidth: '1400px', margin: '0 auto' }}>

                {/* ── 標題列 ── */}
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
                        </p>
                    </div>
                    <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                        {/* 視圖切換 */}
                        <div style={{ display: 'flex', backgroundColor: '#12151f', borderRadius: '8px', padding: '3px', border: '1px solid #2e3349' }}>
                            <button onClick={() => setViewMode('card')} style={{
                                ...btn(viewMode === 'card' ? '#2e3349' : 'transparent'),
                                padding: '5px 10px', fontSize: '12px', borderRadius: '6px'
                            }}><LayoutGrid size={13} />卡片</button>
                            <button onClick={() => setViewMode('table')} style={{
                                ...btn(viewMode === 'table' ? '#2e3349' : 'transparent'),
                                padding: '5px 10px', fontSize: '12px', borderRadius: '6px'
                            }}><Table2 size={13} />一覽表</button>
                        </div>
                        <button onClick={updatePrices} disabled={priceLoading || items.length === 0} style={btn('#21253a')}>
                            <RefreshCw size={14} style={{ animation: priceLoading ? 'spin 1s linear infinite' : 'none' }} />
                            {priceLoading ? '更新中...' : '更新現價'}
                        </button>
                        <button onClick={() => { setShowForm(!showForm); setForm(emptyForm) }} style={btn('#4f8ef7')}>
                            <Plus size={14} />{showForm ? '取消' : '新增自選股'}
                        </button>
                    </div>
                </div>

                {/* ── 族群篩選列 ── */}
                {allGroups.length > 1 && (
                    <div style={{ display: 'flex', gap: '8px', marginBottom: '16px', flexWrap: 'wrap', alignItems: 'center' }}>
                        <Tag size={13} style={{ color: '#8892a4', flexShrink: 0 }} />
                        {['all', ...allGroups].map(g => (
                            <button key={g} onClick={() => setFilterGroup(g)} style={{
                                ...btn(filterGroup === g ? '#4f8ef7' : '#21253a'),
                                padding: '4px 12px', fontSize: '12px', borderRadius: '20px',
                                border: `1px solid ${filterGroup === g ? '#4f8ef7' : '#2e3349'}`
                            }}>
                                {g === 'all' ? `全部 (${items.length})` : `${g} (${items.filter(i => (i.group || UNGROUPED) === g).length})`}
                            </button>
                        ))}
                    </div>
                )}

                {/* ── 新增表單 ── */}
                {showForm && (
                    <div style={{ ...card, marginBottom: '20px' }}>
                        <div style={{ fontSize: '14px', fontWeight: 600, color: '#e2e8f0', marginBottom: '16px' }}>新增自選股</div>
                        <div className="form-grid">
                            <div>
                                <label style={lbl}>股票代號 *</label>
                                <input style={inp} placeholder="如：2330" value={form.code}
                                    onChange={e => {
                                        const code = e.target.value.toUpperCase()
                                        setForm(f => ({ ...f, code, name: stockDict[code] || f.name }))
                                    }} />
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
                                            style={{
                                                ...btn(form.group === g ? '#4f8ef7' : '#21253a'),
                                                padding: '3px 10px', fontSize: '12px', borderRadius: '20px',
                                                border: `1px solid ${form.group === g ? '#4f8ef7' : '#2e3349'}`
                                            }}>{g}</button>
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

                {/* ── 載入中 / 空狀態 ── */}
                {loading ? (
                    <div style={{ textAlign: 'center', padding: '64px', color: '#8892a4' }}>載入中...</div>
                ) : items.length === 0 ? (
                    <div style={{ textAlign: 'center', padding: '64px', color: '#8892a4' }}>
                        <TrendingUp size={32} style={{ marginBottom: '12px', opacity: 0.4 }} />
                        <p style={{ margin: 0 }}>還沒有自選股，點「新增自選股」開始追蹤</p>
                    </div>
                ) : viewMode === 'table' ? (

                    /* ════════════════════════════════════════════════
                       一 覽 表 視 圖
                    ════════════════════════════════════════════════ */
                    <div style={{ ...card, padding: 0, overflow: 'hidden' }}>
                        {/* 摘要列 */}
                        <div style={{ display: 'flex', gap: '1px', backgroundColor: '#2e3349' }}>
                            {[
                                { label: '全部', value: items.length, color: '#e2e8f0' },
                                { label: '達上標', value: items.filter(i => i.currentPrice && i.targetHigh && i.currentPrice >= i.targetHigh).length, color: '#00c896' },
                                { label: '達下標', value: items.filter(i => i.currentPrice && i.targetLow && i.currentPrice <= i.targetLow).length, color: '#ff5757' },
                                {
                                    label: '接近±10%', value: items.filter(i => {
                                        if (!i.currentPrice) return false
                                        const nearH = i.targetHigh && !(i.currentPrice >= i.targetHigh) && Math.abs((i.targetHigh - i.currentPrice) / i.currentPrice * 100) <= 10
                                        const nearL = i.targetLow && !(i.currentPrice <= i.targetLow) && Math.abs((i.targetLow - i.currentPrice) / i.currentPrice * 100) <= 10
                                        return nearH || nearL
                                    }).length, color: '#f5a623'
                                },
                            ].map(({ label, value, color }) => (
                                <div key={label} style={{ flex: 1, backgroundColor: '#1a1d27', padding: '10px 12px', textAlign: 'center' }}>
                                    <div style={{ fontSize: '18px', fontWeight: 700, color, lineHeight: 1 }}>{value}</div>
                                    <div style={{ fontSize: '10px', color: '#6b7690', marginTop: '3px' }}>{label}</div>
                                </div>
                            ))}
                        </div>

                        {/* 表格 */}
                        <div style={{ overflowX: 'auto' }}>
                            <table className="overview-table">
                                <thead>
                                    <tr>
                                        <th>股票</th>
                                        <th style={{ textAlign: 'right' }}>現價</th>
                                        <th>↓ 下標（買入）</th>
                                        <th>↑ 上標（賣出）</th>
                                        <th></th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {/* 依族群分組顯示 */}
                                    {groupKeys.map(g => {
                                        const groupItems = grouped[g]
                                        const isCollapsed = collapsedGroups.has(g)
                                        const groupReached = groupItems.filter(i => getPriceStatus(i) !== 'normal').length
                                        return (
                                            <>
                                                {/* 族群標題行 */}
                                                {groupKeys.length > 1 && (
                                                    <tr key={`header-${g}`} style={{ backgroundColor: '#12151f', cursor: 'pointer' }}
                                                        onClick={() => toggleGroup(g)}>
                                                        <td colSpan={5} style={{ padding: '5px 12px' }}>
                                                            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                                                {isCollapsed ? <ChevronRight size={13} color="#6b7690" /> : <ChevronDown size={13} color="#6b7690" />}
                                                                <span style={{ fontSize: '12px', fontWeight: 600, color: '#e2e8f0' }}>{g}</span>
                                                                <span style={{ fontSize: '10px', color: '#6b7690' }}>{groupItems.length} 檔</span>
                                                                {groupReached > 0 && (
                                                                    <span style={{ fontSize: '10px', backgroundColor: 'rgba(245,166,35,0.15)', color: '#f5a623', borderRadius: '8px', padding: '1px 6px' }}>
                                                                        {groupReached} 達標
                                                                    </span>
                                                                )}
                                                            </div>
                                                        </td>
                                                    </tr>
                                                )}
                                                {/* 股票行 */}
                                                {!isCollapsed && groupItems.map(item => (
                                                    <TableRow key={item.code} item={item}
                                                        onEdit={openEdit}
                                                        onDelete={handleDelete} />
                                                ))}
                                            </>
                                        )
                                    })}
                                </tbody>
                            </table>
                        </div>
                    </div>

                ) : (

                    /* ════════════════════════════════════════════════
                       卡 片 視 圖（依族群分組）
                    ════════════════════════════════════════════════ */
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                        {groupKeys.map(g => {
                            const groupItems = grouped[g]
                            const isCollapsed = collapsedGroups.has(g)
                            const groupReached = groupItems.filter(i => getPriceStatus(i) !== 'normal').length
                            return (
                                <div key={g}>
                                    {/* 族群標頭 */}
                                    {groupKeys.length > 1 || filterGroup !== 'all' ? (
                                        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '12px', cursor: 'pointer' }}
                                            onClick={() => toggleGroup(g)}>
                                            {isCollapsed ? <ChevronRight size={16} color="#8892a4" /> : <ChevronDown size={16} color="#8892a4" />}
                                            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                                <span style={{ fontSize: '15px', fontWeight: 700, color: '#e2e8f0' }}>{g}</span>
                                                <span style={{ fontSize: '12px', color: '#8892a4', backgroundColor: '#21253a', borderRadius: '10px', padding: '1px 8px' }}>{groupItems.length}</span>
                                                {groupReached > 0 && (
                                                    <span style={{ fontSize: '11px', backgroundColor: 'rgba(245,166,35,0.15)', color: '#f5a623', borderRadius: '10px', padding: '1px 8px' }}>
                                                        🔔 {groupReached} 達標
                                                    </span>
                                                )}
                                            </div>
                                            <div style={{ flex: 1, height: '1px', backgroundColor: '#2e3349' }} />
                                        </div>
                                    ) : null}

                                    {!isCollapsed && (
                                        <div className="watch-grid">
                                            {groupItems.map(item => {
                                                const status = getPriceStatus(item)
                                                const isEditing = editingCode === item.code
                                                const borderColor = status === 'high' ? '#00c896' : status === 'low' ? '#ff5757' : '#2e3349'

                                                return (
                                                    <div key={item.code} className="watch-card"
                                                        style={{ backgroundColor: '#1a1d27', border: `1px solid ${borderColor}`, borderRadius: '10px', padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: '6px' }}>

                                                        {/* 第一行：代號 + 名稱 + 操作按鈕 */}
                                                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                                            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0 }}>
                                                                <span style={{ fontSize: '14px', fontWeight: 700, color: '#4f8ef7', flexShrink: 0 }}>{item.code}</span>
                                                                <span style={{ fontSize: '12px', color: '#8892a4', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.name}</span>
                                                                {status === 'high' && <span style={{ fontSize: '10px', backgroundColor: 'rgba(0,200,150,0.15)', color: '#00c896', borderRadius: '8px', padding: '1px 6px', flexShrink: 0 }}>🎯上標</span>}
                                                                {status === 'low' && <span style={{ fontSize: '10px', backgroundColor: 'rgba(255,87,87,0.15)', color: '#ff5757', borderRadius: '8px', padding: '1px 6px', flexShrink: 0 }}>🎯下標</span>}
                                                            </div>
                                                            <div style={{ display: 'flex', gap: '2px', flexShrink: 0 }}>
                                                                <button onClick={() => openEdit(item)} style={{ background: 'none', border: 'none', color: '#4a5568', cursor: 'pointer', padding: '2px' }}><Pencil size={12} /></button>
                                                                <button onClick={() => handleDelete(item.code)} style={{ background: 'none', border: 'none', color: '#4a5568', cursor: 'pointer', padding: '2px' }}><Trash2 size={12} /></button>
                                                            </div>
                                                        </div>

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

                                                        {/* 第三行：進度條（只在有現價+目標時顯示） */}
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
                                                                                style={{
                                                                                    ...btn(form.group === g ? '#4f8ef7' : '#21253a'),
                                                                                    padding: '2px 8px', fontSize: '11px', borderRadius: '20px',
                                                                                    border: `1px solid ${form.group === g ? '#4f8ef7' : '#2e3349'}`
                                                                                }}>{g}</button>
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
                                                                {/* 評估筆記（收折式） */}
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