import { useState, useEffect, useCallback } from 'react'
import { addDoc, getDocs, deleteDoc, updateDoc, orderBy, query } from 'firebase/firestore'
import { investDB } from '../../lib/firebase'
import { userCol, userDoc } from '../../lib/userDB'
import { getQuote, extractPrice } from '../../lib/fugle'
import { Plus, Trash2, RefreshCw, TrendingUp, TrendingDown, Target, Minus, ChevronDown, ChevronRight, Pencil, Check, X } from 'lucide-react'

// ── Types ──────────────────────────────────────────────────────────────────

interface SentimentRecord {
    id?: string
    code: string
    name: string
    direction: 'bull' | 'bear'
    recordPrice: number
    currentPrice?: number
    reason: string
    createdAt: string
    createdTs: number
}

interface StockGroup {
    code: string
    name: string
    records: SentimentRecord[]
}

// ── 樣式常數 ───────────────────────────────────────────────────────────────

const card: React.CSSProperties = {
    backgroundColor: '#1a1d27',
    border: '1px solid #2e3349',
    borderRadius: '12px',
    padding: '20px',
}

const inp: React.CSSProperties = {
    backgroundColor: '#0f1117',
    border: '1px solid #2e3349',
    borderRadius: '8px',
    padding: '8px 12px',
    color: '#e2e8f0',
    fontSize: '14px',
    width: '100%',
    outline: 'none',
    boxSizing: 'border-box',
}

const lbl: React.CSSProperties = {
    fontSize: '12px',
    color: '#8892a4',
    display: 'block',
    marginBottom: '4px',
}

const btn = (color: string, extra?: React.CSSProperties): React.CSSProperties => ({
    backgroundColor: color,
    border: 'none',
    borderRadius: '8px',
    padding: '8px 16px',
    color: '#fff',
    fontSize: '14px',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    ...extra,
})

// ── 勝負計算 ───────────────────────────────────────────────────────────────

type Verdict = 'win' | 'lose' | 'draw' | 'pending'

function calcVerdict(record: SentimentRecord): { verdict: Verdict; changePct: number | null } {
    const cur = record.currentPrice
    if (!cur || !record.recordPrice) return { verdict: 'pending', changePct: null }
    const changePct = ((cur - record.recordPrice) / record.recordPrice) * 100
    const threshold = 0.3
    if (Math.abs(changePct) < threshold) return { verdict: 'draw', changePct }
    if (record.direction === 'bull') return { verdict: changePct > 0 ? 'win' : 'lose', changePct }
    return { verdict: changePct < 0 ? 'win' : 'lose', changePct }
}

function daysSince(dateStr: string): number {
    const now = new Date()
    const created = new Date(dateStr)
    return Math.floor((now.getTime() - created.getTime()) / (1000 * 60 * 60 * 24))
}

const verdictStyle = (v: Verdict): React.CSSProperties => ({
    fontSize: '11px',
    fontWeight: 700,
    padding: '2px 8px',
    borderRadius: '20px',
    backgroundColor:
        v === 'win' ? 'rgba(0,200,150,0.15)' :
            v === 'lose' ? 'rgba(255,87,87,0.15)' :
                v === 'draw' ? 'rgba(245,166,35,0.15)' :
                    'rgba(136,146,164,0.15)',
    color:
        v === 'win' ? '#00c896' :
            v === 'lose' ? '#ff5757' :
                v === 'draw' ? '#f5a623' :
                    '#8892a4',
})

const verdictLabel = (v: Verdict) =>
    v === 'win' ? '✓ 勝' : v === 'lose' ? '✗ 敗' : v === 'draw' ? '— 平' : '待定'

// ── 群組勝率計算 ────────────────────────────────────────────────────────────

function calcGroupStats(records: SentimentRecord[]) {
    const settled = records.filter(r => r.currentPrice && r.recordPrice)
    const wins = settled.filter(r => calcVerdict(r).verdict === 'win').length
    const loses = settled.filter(r => calcVerdict(r).verdict === 'lose').length
    const draws = settled.filter(r => calcVerdict(r).verdict === 'draw').length
    const winRate = settled.length > 0 ? Math.round((wins / settled.length) * 100) : null
    return { wins, loses, draws, total: records.length, settled: settled.length, winRate }
}

// ── 主元件 ─────────────────────────────────────────────────────────────────

export default function SentimentTracker() {
    const [records, setRecords] = useState<SentimentRecord[]>([])
    const [loading, setLoading] = useState(true)
    const [priceLoading, setPriceLoading] = useState(false)
    const [showForm, setShowForm] = useState(false)
    const [saving, setSaving] = useState(false)
    const [stockDict, setStockDict] = useState<Record<string, string>>({})
    const [lastUpdated, setLastUpdated] = useState('')
    const [deletingId, setDeletingId] = useState<string | null>(null)
    const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set())
    const [editingId, setEditingId] = useState<string | null>(null)
    const [editForm, setEditForm] = useState<{ direction: 'bull' | 'bear'; recordPrice: string; reason: string }>({ direction: 'bull', recordPrice: '', reason: '' })
    const [savingEditId, setSavingEditId] = useState<string | null>(null)

    const [form, setForm] = useState({
        code: '',
        name: '',
        direction: 'bull' as 'bull' | 'bear',
        reason: '',
    })

    // ── 載入資料 ────────────────────────────────────────────────────────────

    const load = useCallback(async () => {
        setLoading(true)
        const [snap, dictSnap] = await Promise.all([
            getDocs(query(userCol(investDB, 'sentiments'), orderBy('createdTs', 'desc'))),
            getDocs(userCol(investDB, 'stockDict')),
        ])
        const dict: Record<string, string> = {}
        dictSnap.docs.forEach(d => { dict[d.id] = d.data().name })
        setStockDict(dict)
        const data = snap.docs.map(d => ({ id: d.id, ...d.data() } as SentimentRecord))
        setRecords(data)
        setLoading(false)
    }, [])

    useEffect(() => { load() }, [load])

    // ── 群組化（依股票代號分組，組內依時間新→舊） ───────────────────────────

    const groups: StockGroup[] = (() => {
        const map: Record<string, StockGroup> = {}
        records.forEach(r => {
            if (!map[r.code]) map[r.code] = { code: r.code, name: r.name, records: [] }
            map[r.code].records.push(r)
        })
        // 群組排序：依最新一筆記錄時間排
        return Object.values(map).sort((a, b) =>
            (b.records[0]?.createdTs ?? 0) - (a.records[0]?.createdTs ?? 0)
        )
    })()

    const toggleGroup = (code: string) => {
        setExpandedGroups(prev => {
            const next = new Set(prev)
            if (next.has(code)) next.delete(code); else next.add(code)
            return next
        })
    }

    // ── 更新現價 ────────────────────────────────────────────────────────────

    const handleRefreshPrices = async () => {
        if (records.length === 0) return
        setPriceLoading(true)
        try {
            const codes = [...new Set(records.map(r => r.code))]
            const priceMap: Record<string, number | null> = {}
            await Promise.all(codes.map(async code => {
                const quote = await getQuote(code)
                priceMap[code] = extractPrice(quote)
            }))
            setRecords(prev => prev.map(r => ({
                ...r,
                currentPrice: priceMap[r.code] ?? r.currentPrice,
            })))
            setLastUpdated(new Date().toLocaleString('zh-TW'))
        } finally {
            setPriceLoading(false)
        }
    }

    // ── 新增記錄 ────────────────────────────────────────────────────────────

    const handleAdd = async () => {
        if (!form.code.trim()) return
        setSaving(true)
        try {
            const quote = await getQuote(form.code.toUpperCase())
            const recordPrice = extractPrice(quote) ?? 0
            const now = new Date()
            const newRecord: Omit<SentimentRecord, 'id'> = {
                code: form.code.toUpperCase(),
                name: form.name || stockDict[form.code.toUpperCase()] || form.code.toUpperCase(),
                direction: form.direction,
                recordPrice,
                reason: form.reason,
                createdAt: now.toISOString().split('T')[0],
                createdTs: now.getTime(),
            }
            await addDoc(userCol(investDB, 'sentiments'), newRecord)
            setForm({ code: '', name: '', direction: 'bull', reason: '' })
            setShowForm(false)
            await load()
        } finally {
            setSaving(false)
        }
    }

    const handleCodeChange = (code: string) => {
        const upper = code.toUpperCase()
        setForm(f => ({ ...f, code: upper, name: stockDict[upper] || f.name }))
    }

    // ── 刪除 ────────────────────────────────────────────────────────────────

    const handleDelete = async (id: string) => {
        setDeletingId(id)
        await deleteDoc(userDoc(investDB, 'sentiments', id))
        setRecords(prev => prev.filter(r => r.id !== id))
        setDeletingId(null)
    }

    // ── 編輯整筆記錄 ─────────────────────────────────────────────────────────

    const handleStartEdit = (record: SentimentRecord) => {
        setEditingId(record.id!)
        setEditForm({
            direction: record.direction,
            recordPrice: record.recordPrice > 0 ? String(record.recordPrice) : '',
            reason: record.reason ?? '',
        })
    }

    const handleSaveEdit = async (record: SentimentRecord) => {
        const price = parseFloat(editForm.recordPrice)
        if (isNaN(price) || price <= 0) return
        setSavingEditId(record.id!)
        try {
            const updates = {
                direction: editForm.direction,
                recordPrice: price,
                reason: editForm.reason,
            }
            await updateDoc(userDoc(investDB, 'sentiments', record.id!), updates)
            setRecords(prev => prev.map(r => r.id === record.id ? { ...r, ...updates } : r))
            setEditingId(null)
        } finally {
            setSavingEditId(null)
        }
    }


    const allSettled = records.filter(r => r.currentPrice && r.recordPrice)
    const allWins = allSettled.filter(r => calcVerdict(r).verdict === 'win').length
    const allLoses = allSettled.filter(r => calcVerdict(r).verdict === 'lose').length
    const allDraws = allSettled.filter(r => calcVerdict(r).verdict === 'draw').length
    const overallWinRate = allSettled.length > 0 ? Math.round((allWins / allSettled.length) * 100) : null

    // 每檔股票平均勝率（各檔 winRate 加總 / 有 winRate 的檔數）
    const groupWinRates = groups
        .map(g => calcGroupStats(g.records).winRate)
        .filter((r): r is number => r !== null)
    const avgStockWinRate = groupWinRates.length > 0
        ? Math.round(groupWinRates.reduce((a, b) => a + b, 0) / groupWinRates.length)
        : null

    const bullRecords = records.filter(r => r.direction === 'bull')
    const bearRecords = records.filter(r => r.direction === 'bear')

    // ── Render ──────────────────────────────────────────────────────────────

    return (
        <div style={{ padding: 'clamp(16px, 3vw, 32px)', maxWidth: '960px', margin: '0 auto' }}>
            <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>

            {/* ── 標題列 ── */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '24px', flexWrap: 'wrap', gap: '12px' }}>
                <div>
                    <h1 style={{ fontSize: 'clamp(18px, 2.5vw, 22px)', fontWeight: 700, color: '#e2e8f0', margin: 0 }}>觀點追蹤</h1>
                    <p style={{ fontSize: '13px', color: '#8892a4', margin: '4px 0 0' }}>記錄每次對股票的看多/看空，追蹤波段判斷勝率</p>
                </div>
                <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                    {lastUpdated && <span style={{ fontSize: '11px', color: '#8892a4' }}>更新：{lastUpdated}</span>}
                    <button onClick={handleRefreshPrices} disabled={priceLoading || records.length === 0}
                        style={btn('#2e3349', { opacity: priceLoading ? 0.6 : 1 })}>
                        <RefreshCw size={14} style={{ animation: priceLoading ? 'spin 1s linear infinite' : 'none' }} />
                        更新現價
                    </button>
                    <button onClick={() => setShowForm(v => !v)} style={btn('#4f8ef7')}>
                        <Plus size={14} />新增觀點
                    </button>
                </div>
            </div>

            {/* ── 統計卡片 ── */}
            {records.length > 0 && (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '12px', marginBottom: '20px' }}>

                    {/* 整體勝率（所有記錄加總） */}
                    <div style={{ ...card, textAlign: 'center' }}>
                        <div style={{ fontSize: '11px', color: '#8892a4', marginBottom: '6px' }}>整體勝率</div>
                        <div style={{ fontSize: '26px', fontWeight: 800, color: overallWinRate !== null ? (overallWinRate >= 50 ? '#00c896' : '#ff5757') : '#8892a4' }}>
                            {overallWinRate !== null ? `${overallWinRate}%` : '—'}
                        </div>
                        <div style={{ fontSize: '11px', color: '#8892a4', marginTop: '4px' }}>
                            {allSettled.length > 0 ? `${allWins}勝 ${allLoses}敗 ${allDraws}平` : '更新現價後顯示'}
                        </div>
                        <div style={{ fontSize: '10px', color: '#8892a4', marginTop: '2px', opacity: 0.6 }}>所有記錄加總</div>
                    </div>

                    {/* 每檔平均勝率 */}
                    <div style={{ ...card, textAlign: 'center' }}>
                        <div style={{ fontSize: '11px', color: '#8892a4', marginBottom: '6px' }}>每檔平均勝率</div>
                        <div style={{ fontSize: '26px', fontWeight: 800, color: avgStockWinRate !== null ? (avgStockWinRate >= 50 ? '#00c896' : '#ff5757') : '#8892a4' }}>
                            {avgStockWinRate !== null ? `${avgStockWinRate}%` : '—'}
                        </div>
                        <div style={{ fontSize: '11px', color: '#8892a4', marginTop: '4px' }}>
                            {groupWinRates.length > 0 ? `${groupWinRates.length} 檔有結果` : '更新現價後顯示'}
                        </div>
                        <div style={{ fontSize: '10px', color: '#8892a4', marginTop: '2px', opacity: 0.6 }}>各檔勝率加權平均</div>
                    </div>

                    {/* 看多勝率 */}
                    <div style={{ ...card, textAlign: 'center', borderColor: 'rgba(0,200,150,0.25)' }}>
                        <div style={{ fontSize: '11px', color: '#8892a4', marginBottom: '6px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '4px' }}>
                            <TrendingUp size={12} color="#00c896" />看多勝率
                        </div>
                        {(() => {
                            const s = bullRecords.filter(r => r.currentPrice && r.recordPrice)
                            const w = s.filter(r => calcVerdict(r).verdict === 'win').length
                            const rate = s.length > 0 ? Math.round((w / s.length) * 100) : null
                            return <>
                                <div style={{ fontSize: '26px', fontWeight: 800, color: '#00c896' }}>{rate !== null ? `${rate}%` : '—'}</div>
                                <div style={{ fontSize: '11px', color: '#8892a4', marginTop: '4px' }}>{s.length > 0 ? `${w}勝 / ${s.length}筆` : `共 ${bullRecords.length} 筆`}</div>
                            </>
                        })()}
                    </div>

                    {/* 看空勝率 */}
                    <div style={{ ...card, textAlign: 'center', borderColor: 'rgba(255,87,87,0.25)' }}>
                        <div style={{ fontSize: '11px', color: '#8892a4', marginBottom: '6px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '4px' }}>
                            <TrendingDown size={12} color="#ff5757" />看空勝率
                        </div>
                        {(() => {
                            const s = bearRecords.filter(r => r.currentPrice && r.recordPrice)
                            const w = s.filter(r => calcVerdict(r).verdict === 'win').length
                            const rate = s.length > 0 ? Math.round((w / s.length) * 100) : null
                            return <>
                                <div style={{ fontSize: '26px', fontWeight: 800, color: '#ff5757' }}>{rate !== null ? `${rate}%` : '—'}</div>
                                <div style={{ fontSize: '11px', color: '#8892a4', marginTop: '4px' }}>{s.length > 0 ? `${w}勝 / ${s.length}筆` : `共 ${bearRecords.length} 筆`}</div>
                            </>
                        })()}
                    </div>

                    {/* 總記錄 */}
                    <div style={{ ...card, textAlign: 'center' }}>
                        <div style={{ fontSize: '11px', color: '#8892a4', marginBottom: '6px' }}>追蹤中</div>
                        <div style={{ fontSize: '26px', fontWeight: 800, color: '#e2e8f0' }}>{groups.length}<span style={{ fontSize: '13px', fontWeight: 400, color: '#8892a4' }}> 檔</span></div>
                        <div style={{ fontSize: '11px', color: '#8892a4', marginTop: '4px' }}>{records.length} 筆記錄</div>
                    </div>
                </div>
            )}

            {/* ── 新增表單 ── */}
            {showForm && (
                <div style={{ ...card, marginBottom: '20px', borderColor: '#4f8ef7' }}>
                    <div style={{ fontSize: '14px', fontWeight: 600, color: '#e2e8f0', marginBottom: '16px' }}>新增觀點</div>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '12px', marginBottom: '12px' }}>
                        <div>
                            <label style={lbl}>股票代號</label>
                            <input style={inp} placeholder="例：2330" value={form.code}
                                onChange={e => handleCodeChange(e.target.value)} />
                        </div>
                        <div>
                            <label style={lbl}>股票名稱</label>
                            <input style={inp} placeholder="自動帶入或手填" value={form.name}
                                onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />
                        </div>
                        <div>
                            <label style={lbl}>方向</label>
                            <div style={{ display: 'flex', gap: '8px' }}>
                                {(['bull', 'bear'] as const).map(dir => (
                                    <button key={dir} onClick={() => setForm(f => ({ ...f, direction: dir }))}
                                        style={{
                                            flex: 1, padding: '8px', borderRadius: '8px', border: '1px solid',
                                            cursor: 'pointer', fontSize: '13px', fontWeight: 600,
                                            borderColor: form.direction === dir ? (dir === 'bull' ? '#00c896' : '#ff5757') : '#2e3349',
                                            backgroundColor: form.direction === dir ? (dir === 'bull' ? 'rgba(0,200,150,0.12)' : 'rgba(255,87,87,0.12)') : '#0f1117',
                                            color: form.direction === dir ? (dir === 'bull' ? '#00c896' : '#ff5757') : '#8892a4',
                                            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '4px',
                                        }}>
                                        {dir === 'bull' ? <><TrendingUp size={13} />看多</> : <><TrendingDown size={13} />看空</>}
                                    </button>
                                ))}
                            </div>
                        </div>
                    </div>
                    <div style={{ marginBottom: '12px' }}>
                        <label style={lbl}>理由/想法</label>
                        <textarea style={{ ...inp, minHeight: '72px', resize: 'vertical' }}
                            placeholder="記錄你當下的判斷依據，事後對照用..."
                            value={form.reason}
                            onChange={e => setForm(f => ({ ...f, reason: e.target.value }))} />
                    </div>
                    <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
                        <button onClick={() => setShowForm(false)} style={btn('#2e3349')}>取消</button>
                        <button onClick={handleAdd} disabled={saving || !form.code.trim()}
                            style={btn('#4f8ef7', { opacity: saving || !form.code.trim() ? 0.6 : 1 })}>
                            {saving ? '儲存中...' : '記錄（並抓今日股價）'}
                        </button>
                    </div>
                </div>
            )}

            {/* ── 群組列表 ── */}
            {loading ? (
                <div style={{ textAlign: 'center', padding: '48px', color: '#8892a4' }}>載入中...</div>
            ) : groups.length === 0 ? (
                <div style={{ ...card, textAlign: 'center', padding: '48px' }}>
                    <Target size={32} color="#2e3349" style={{ marginBottom: '12px' }} />
                    <p style={{ color: '#8892a4', margin: 0 }}>尚無觀點記錄</p>
                    <p style={{ color: '#8892a4', fontSize: '13px', margin: '6px 0 0' }}>點上方「新增觀點」開始記錄你的判斷</p>
                </div>
            ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                    {groups.map(group => {
                        const isExpanded = expandedGroups.has(group.code)
                        const stats = calcGroupStats(group.records)
                        const currentPrice = group.records[0]?.currentPrice

                        return (
                            <div key={group.code} style={{ ...card, padding: 0, overflow: 'hidden' }}>

                                {/* ── 群組標題（點擊收合/展開） ── */}
                                <div
                                    onClick={() => toggleGroup(group.code)}
                                    style={{ padding: '16px 20px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}
                                >
                                    {/* 展開箭頭 */}
                                    <span style={{ color: '#8892a4', display: 'flex', flexShrink: 0 }}>
                                        {isExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                                    </span>

                                    {/* 股票代號 + 名稱 */}
                                    <div style={{ flex: 1, minWidth: 0 }}>
                                        <span style={{ fontWeight: 700, color: '#e2e8f0', fontSize: '15px' }}>{group.code}</span>
                                        {group.name && group.name !== group.code && (
                                            <span style={{ color: '#8892a4', fontSize: '13px', marginLeft: '8px' }}>{group.name}</span>
                                        )}
                                    </div>

                                    {/* 勝率 badge */}
                                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 }}>
                                        {stats.winRate !== null && (
                                            <span style={{
                                                fontSize: '13px', fontWeight: 700,
                                                color: stats.winRate >= 50 ? '#00c896' : '#ff5757',
                                                backgroundColor: stats.winRate >= 50 ? 'rgba(0,200,150,0.1)' : 'rgba(255,87,87,0.1)',
                                                padding: '2px 10px', borderRadius: '20px',
                                            }}>
                                                {stats.winRate}%
                                            </span>
                                        )}
                                        <span style={{ fontSize: '12px', color: '#8892a4' }}>
                                            {stats.settled > 0
                                                ? `${stats.wins}勝 ${stats.loses}敗${stats.draws > 0 ? ` ${stats.draws}平` : ''}`
                                                : `${stats.total}筆`}
                                        </span>
                                        {currentPrice && (
                                            <span style={{ fontSize: '12px', color: '#e2e8f0', backgroundColor: '#0f1117', padding: '2px 8px', borderRadius: '6px' }}>
                                                現價 ${currentPrice.toFixed(2)}
                                            </span>
                                        )}
                                    </div>
                                </div>

                                {/* ── 展開內容：每筆記錄 ── */}
                                {isExpanded && (
                                    <div style={{ borderTop: '1px solid #2e3349' }}>
                                        {group.records.map((record, idx) => {
                                            const { verdict, changePct } = calcVerdict(record)
                                            const days = daysSince(record.createdAt)
                                            const dirColor = record.direction === 'bull' ? '#00c896' : '#ff5757'

                                            return (
                                                <div key={record.id} style={{
                                                    padding: '14px 20px',
                                                    borderBottom: idx < group.records.length - 1 ? '1px solid #1e2235' : 'none',
                                                    borderLeft: `3px solid ${dirColor}`,
                                                    backgroundColor: '#141720',
                                                }}>
                                                    {editingId === record.id ? (
                                                        /* ── 編輯模式 ── */
                                                        <div onClick={e => e.stopPropagation()}>
                                                            <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '12px', alignItems: 'start', marginBottom: '10px' }}>
                                                                {/* 方向 */}
                                                                <div>
                                                                    <div style={{ fontSize: '10px', color: '#8892a4', marginBottom: '4px' }}>方向</div>
                                                                    <div style={{ display: 'flex', gap: '6px' }}>
                                                                        {(['bull', 'bear'] as const).map(dir => (
                                                                            <button key={dir} onClick={() => setEditForm(f => ({ ...f, direction: dir }))}
                                                                                style={{
                                                                                    padding: '5px 12px', borderRadius: '6px', border: '1px solid',
                                                                                    cursor: 'pointer', fontSize: '12px', fontWeight: 600,
                                                                                    borderColor: editForm.direction === dir ? (dir === 'bull' ? '#00c896' : '#ff5757') : '#2e3349',
                                                                                    backgroundColor: editForm.direction === dir ? (dir === 'bull' ? 'rgba(0,200,150,0.15)' : 'rgba(255,87,87,0.15)') : '#0f1117',
                                                                                    color: editForm.direction === dir ? (dir === 'bull' ? '#00c896' : '#ff5757') : '#8892a4',
                                                                                    display: 'flex', alignItems: 'center', gap: '4px',
                                                                                }}>
                                                                                {dir === 'bull' ? <><TrendingUp size={11} />看多</> : <><TrendingDown size={11} />看空</>}
                                                                            </button>
                                                                        ))}
                                                                    </div>
                                                                </div>
                                                                {/* 記錄價 */}
                                                                <div>
                                                                    <div style={{ fontSize: '10px', color: '#8892a4', marginBottom: '4px' }}>記錄價</div>
                                                                    <input
                                                                        autoFocus
                                                                        type="number"
                                                                        value={editForm.recordPrice}
                                                                        onChange={e => setEditForm(f => ({ ...f, recordPrice: e.target.value }))}
                                                                        style={{ ...inp, fontSize: '13px', padding: '5px 10px', border: '1px solid #4f8ef7' }}
                                                                    />
                                                                </div>
                                                            </div>
                                                            {/* 理由 */}
                                                            <div style={{ marginBottom: '10px' }}>
                                                                <div style={{ fontSize: '10px', color: '#8892a4', marginBottom: '4px' }}>理由/想法</div>
                                                                <textarea
                                                                    value={editForm.reason}
                                                                    onChange={e => setEditForm(f => ({ ...f, reason: e.target.value }))}
                                                                    style={{ ...inp, fontSize: '12px', minHeight: '60px', resize: 'vertical', padding: '6px 10px' }}
                                                                />
                                                            </div>
                                                            {/* 操作按鈕 */}
                                                            <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
                                                                <button onClick={() => setEditingId(null)}
                                                                    style={btn('#2e3349', { fontSize: '12px', padding: '6px 12px' })}>
                                                                    <X size={12} />取消
                                                                </button>
                                                                <button onClick={() => handleSaveEdit(record)}
                                                                    disabled={savingEditId === record.id || !editForm.recordPrice}
                                                                    style={btn('#4f8ef7', { fontSize: '12px', padding: '6px 12px', opacity: savingEditId === record.id ? 0.6 : 1 })}>
                                                                    <Check size={12} />{savingEditId === record.id ? '儲存中...' : '儲存'}
                                                                </button>
                                                            </div>
                                                        </div>
                                                    ) : (
                                                        /* ── 檢視模式 ── */
                                                        <>
                                                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '12px', flexWrap: 'wrap' }}>
                                                                {/* 左側 */}
                                                                <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
                                                                    {/* 方向 badge */}
                                                                    <div style={{
                                                                        display: 'flex', alignItems: 'center', gap: '4px',
                                                                        backgroundColor: record.direction === 'bull' ? 'rgba(0,200,150,0.12)' : 'rgba(255,87,87,0.12)',
                                                                        color: dirColor, borderRadius: '6px', padding: '3px 8px',
                                                                        fontSize: '12px', fontWeight: 700,
                                                                    }}>
                                                                        {record.direction === 'bull' ? <TrendingUp size={12} /> : <TrendingDown size={12} />}
                                                                        {record.direction === 'bull' ? '看多' : '看空'}
                                                                    </div>

                                                                    {/* 勝負 */}
                                                                    <span style={verdictStyle(verdict)}>{verdictLabel(verdict)}</span>

                                                                    {/* 日期 + 天數 */}
                                                                    <span style={{ fontSize: '12px', color: '#8892a4' }}>
                                                                        {record.createdAt}
                                                                        <span style={{ marginLeft: '6px', opacity: 0.6 }}>（{days}天前）</span>
                                                                    </span>
                                                                </div>

                                                                {/* 右側：價格 + 編輯 + 刪除 */}
                                                                <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                                                                    <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
                                                                        <div style={{ textAlign: 'center' }}>
                                                                            <div style={{ fontSize: '10px', color: '#8892a4' }}>記錄價</div>
                                                                            <div style={{ fontSize: '13px', fontWeight: 600, color: '#e2e8f0' }}>
                                                                                {record.recordPrice > 0 ? `$${record.recordPrice.toFixed(2)}` : '—'}
                                                                            </div>
                                                                        </div>
                                                                        <Minus size={10} color="#2e3349" />
                                                                        <div style={{ textAlign: 'center' }}>
                                                                            <div style={{ fontSize: '10px', color: '#8892a4' }}>現價</div>
                                                                            <div style={{ fontSize: '13px', fontWeight: 600, color: record.currentPrice ? '#e2e8f0' : '#8892a4' }}>
                                                                                {record.currentPrice ? `$${record.currentPrice.toFixed(2)}` : '—'}
                                                                            </div>
                                                                        </div>
                                                                        {changePct !== null && (
                                                                            <div style={{
                                                                                fontSize: '12px', fontWeight: 700,
                                                                                color: changePct > 0 ? '#00c896' : changePct < 0 ? '#ff5757' : '#8892a4',
                                                                            }}>
                                                                                {changePct > 0 ? '+' : ''}{changePct.toFixed(2)}%
                                                                            </div>
                                                                        )}
                                                                    </div>
                                                                    {/* 編輯按鈕 */}
                                                                    <button
                                                                        onClick={e => { e.stopPropagation(); handleStartEdit(record) }}
                                                                        style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#8892a4', padding: '4px', display: 'flex', opacity: 0.6 }}
                                                                        onMouseEnter={e => (e.currentTarget.style.opacity = '1')}
                                                                        onMouseLeave={e => (e.currentTarget.style.opacity = '0.6')}
                                                                    >
                                                                        <Pencil size={14} />
                                                                    </button>
                                                                    {/* 刪除按鈕 */}
                                                                    <button
                                                                        onClick={e => { e.stopPropagation(); record.id && handleDelete(record.id) }}
                                                                        disabled={deletingId === record.id}
                                                                        style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#8892a4', padding: '4px', display: 'flex', opacity: deletingId === record.id ? 0.4 : 1 }}
                                                                        onMouseEnter={e => (e.currentTarget.style.color = '#ff5757')}
                                                                        onMouseLeave={e => (e.currentTarget.style.color = '#8892a4')}
                                                                    >
                                                                        <Trash2 size={14} />
                                                                    </button>
                                                                </div>
                                                            </div>

                                                            {/* 理由 */}
                                                            {record.reason && (
                                                                <div style={{
                                                                    marginTop: '8px', padding: '6px 10px',
                                                                    backgroundColor: '#0f1117', borderRadius: '6px',
                                                                    fontSize: '12px', color: '#8892a4', lineHeight: 1.5,
                                                                    borderLeft: `2px solid ${dirColor}`,
                                                                }}>
                                                                    {record.reason}
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
    )
}