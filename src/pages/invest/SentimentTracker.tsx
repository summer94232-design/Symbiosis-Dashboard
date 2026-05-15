import { useState, useEffect, useCallback } from 'react'
import { addDoc, getDocs, deleteDoc, orderBy, query } from 'firebase/firestore'
import { investDB } from '../../lib/firebase'
import { userCol, userDoc } from '../../lib/userDB'
import { getQuote, extractPrice } from '../../lib/fugle'
import { Plus, Trash2, RefreshCw, TrendingUp, TrendingDown, Target, Minus } from 'lucide-react'

// ── Types ──────────────────────────────────────────────────────────────────

interface SentimentRecord {
    id?: string
    code: string
    name: string
    direction: 'bull' | 'bear'
    recordPrice: number       // 記錄當天的股價
    currentPrice?: number     // 即時現價（前端 state，不存 Firebase）
    reason: string
    createdAt: string         // ISO date string YYYY-MM-DD
    createdTs: number         // timestamp for ordering
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
    const threshold = 0.3 // 0.3% 以內算平手
    if (Math.abs(changePct) < threshold) return { verdict: 'draw', changePct }
    if (record.direction === 'bull') return { verdict: changePct > 0 ? 'win' : 'lose', changePct }
    return { verdict: changePct < 0 ? 'win' : 'lose', changePct }
}

// ── 天數計算 ───────────────────────────────────────────────────────────────

function daysSince(dateStr: string): number {
    const now = new Date()
    const created = new Date(dateStr)
    return Math.floor((now.getTime() - created.getTime()) / (1000 * 60 * 60 * 24))
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
    const [filterDir, setFilterDir] = useState<'all' | 'bull' | 'bear'>('all')
    const [deletingId, setDeletingId] = useState<string | null>(null)

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
            // 先抓當下股價作為記錄基準價
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
            // 順便用剛拿到的現價更新 state
            if (recordPrice > 0) {
                setRecords(prev => prev.map(r =>
                    r.code === newRecord.code ? { ...r, currentPrice: recordPrice } : r
                ))
            }
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

    // ── 勝率統計 ────────────────────────────────────────────────────────────

    const withPrice = records.filter(r => r.currentPrice && r.recordPrice)
    const wins = withPrice.filter(r => calcVerdict(r).verdict === 'win').length
    const loses = withPrice.filter(r => calcVerdict(r).verdict === 'lose').length
    const draws = withPrice.filter(r => calcVerdict(r).verdict === 'draw').length
    const winRate = withPrice.length > 0 ? Math.round((wins / withPrice.length) * 100) : null

    const bullRecords = records.filter(r => r.direction === 'bull')
    const bearRecords = records.filter(r => r.direction === 'bear')
    const bullWins = bullRecords.filter(r => r.currentPrice && calcVerdict(r).verdict === 'win').length
    const bullTotal = bullRecords.filter(r => r.currentPrice && r.recordPrice).length
    const bearWins = bearRecords.filter(r => r.currentPrice && calcVerdict(r).verdict === 'win').length
    const bearTotal = bearRecords.filter(r => r.currentPrice && r.recordPrice).length

    // ── 過濾 ────────────────────────────────────────────────────────────────

    const filtered = filterDir === 'all' ? records
        : records.filter(r => r.direction === filterDir)

    // ── 輔助渲染 ────────────────────────────────────────────────────────────

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

    // ── Render ──────────────────────────────────────────────────────────────

    return (
        <div style={{ padding: 'clamp(16px, 3vw, 32px)', maxWidth: '960px', margin: '0 auto' }}>

            {/* ── 標題列 ── */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '24px', flexWrap: 'wrap', gap: '12px' }}>
                <div>
                    <h1 style={{ fontSize: 'clamp(18px, 2.5vw, 22px)', fontWeight: 700, color: '#e2e8f0', margin: 0 }}>觀點追蹤</h1>
                    <p style={{ fontSize: '13px', color: '#8892a4', margin: '4px 0 0' }}>記錄每天對股票的看多/看空，滾動追蹤勝率</p>
                </div>
                <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                    {lastUpdated && <span style={{ fontSize: '11px', color: '#8892a4' }}>更新：{lastUpdated}</span>}
                    <button
                        onClick={handleRefreshPrices}
                        disabled={priceLoading || records.length === 0}
                        style={btn('#2e3349', { opacity: priceLoading ? 0.6 : 1 })}
                    >
                        <RefreshCw size={14} style={{ animation: priceLoading ? 'spin 1s linear infinite' : 'none' }} />
                        更新現價
                    </button>
                    <button onClick={() => setShowForm(v => !v)} style={btn('#4f8ef7')}>
                        <Plus size={14} />新增觀點
                    </button>
                </div>
            </div>

            <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>

            {/* ── 統計卡片 ── */}
            {records.length > 0 && (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '12px', marginBottom: '20px' }}>
                    {/* 總勝率 */}
                    <div style={{ ...card, textAlign: 'center' }}>
                        <div style={{ fontSize: '11px', color: '#8892a4', marginBottom: '6px' }}>整體勝率</div>
                        <div style={{ fontSize: '28px', fontWeight: 800, color: winRate !== null ? (winRate >= 50 ? '#00c896' : '#ff5757') : '#8892a4' }}>
                            {winRate !== null ? `${winRate}%` : '—'}
                        </div>
                        <div style={{ fontSize: '11px', color: '#8892a4', marginTop: '4px' }}>
                            {withPrice.length > 0 ? `${wins}勝 ${loses}敗 ${draws}平` : '尚無現價資料'}
                        </div>
                    </div>

                    {/* 看多勝率 */}
                    <div style={{ ...card, textAlign: 'center', borderColor: 'rgba(0,200,150,0.25)' }}>
                        <div style={{ fontSize: '11px', color: '#8892a4', marginBottom: '6px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '4px' }}>
                            <TrendingUp size={12} color="#00c896" />看多勝率
                        </div>
                        <div style={{ fontSize: '28px', fontWeight: 800, color: '#00c896' }}>
                            {bullTotal > 0 ? `${Math.round((bullWins / bullTotal) * 100)}%` : '—'}
                        </div>
                        <div style={{ fontSize: '11px', color: '#8892a4', marginTop: '4px' }}>
                            {bullTotal > 0 ? `${bullWins}勝 / ${bullTotal}筆` : `共 ${bullRecords.length} 筆`}
                        </div>
                    </div>

                    {/* 看空勝率 */}
                    <div style={{ ...card, textAlign: 'center', borderColor: 'rgba(255,87,87,0.25)' }}>
                        <div style={{ fontSize: '11px', color: '#8892a4', marginBottom: '6px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '4px' }}>
                            <TrendingDown size={12} color="#ff5757" />看空勝率
                        </div>
                        <div style={{ fontSize: '28px', fontWeight: 800, color: '#ff5757' }}>
                            {bearTotal > 0 ? `${Math.round((bearWins / bearTotal) * 100)}%` : '—'}
                        </div>
                        <div style={{ fontSize: '11px', color: '#8892a4', marginTop: '4px' }}>
                            {bearTotal > 0 ? `${bearWins}勝 / ${bearTotal}筆` : `共 ${bearRecords.length} 筆`}
                        </div>
                    </div>

                    {/* 總記錄數 */}
                    <div style={{ ...card, textAlign: 'center' }}>
                        <div style={{ fontSize: '11px', color: '#8892a4', marginBottom: '6px' }}>總記錄數</div>
                        <div style={{ fontSize: '28px', fontWeight: 800, color: '#e2e8f0' }}>{records.length}</div>
                        <div style={{ fontSize: '11px', color: '#8892a4', marginTop: '4px' }}>
                            多 {bullRecords.length} · 空 {bearRecords.length}
                        </div>
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
                                            borderColor: form.direction === dir
                                                ? (dir === 'bull' ? '#00c896' : '#ff5757')
                                                : '#2e3349',
                                            backgroundColor: form.direction === dir
                                                ? (dir === 'bull' ? 'rgba(0,200,150,0.12)' : 'rgba(255,87,87,0.12)')
                                                : '#0f1117',
                                            color: form.direction === dir
                                                ? (dir === 'bull' ? '#00c896' : '#ff5757')
                                                : '#8892a4',
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

            {/* ── 過濾列 ── */}
            {records.length > 0 && (
                <div style={{ display: 'flex', gap: '6px', marginBottom: '16px' }}>
                    {(['all', 'bull', 'bear'] as const).map(dir => (
                        <button key={dir} onClick={() => setFilterDir(dir)}
                            style={{
                                padding: '6px 14px', borderRadius: '20px', border: '1px solid',
                                cursor: 'pointer', fontSize: '12px', fontWeight: filterDir === dir ? 600 : 400,
                                borderColor: filterDir === dir
                                    ? dir === 'bull' ? '#00c896' : dir === 'bear' ? '#ff5757' : '#4f8ef7'
                                    : '#2e3349',
                                backgroundColor: filterDir === dir
                                    ? dir === 'bull' ? 'rgba(0,200,150,0.1)' : dir === 'bear' ? 'rgba(255,87,87,0.1)' : 'rgba(79,142,247,0.1)'
                                    : 'transparent',
                                color: filterDir === dir
                                    ? dir === 'bull' ? '#00c896' : dir === 'bear' ? '#ff5757' : '#4f8ef7'
                                    : '#8892a4',
                            }}>
                            {dir === 'all' ? '全部' : dir === 'bull' ? '▲ 看多' : '▼ 看空'}
                            <span style={{ marginLeft: '4px', opacity: 0.7 }}>
                                {dir === 'all' ? records.length : dir === 'bull' ? bullRecords.length : bearRecords.length}
                            </span>
                        </button>
                    ))}
                </div>
            )}

            {/* ── 記錄列表 ── */}
            {loading ? (
                <div style={{ textAlign: 'center', padding: '48px', color: '#8892a4' }}>載入中...</div>
            ) : filtered.length === 0 ? (
                <div style={{ ...card, textAlign: 'center', padding: '48px' }}>
                    <Target size={32} color="#2e3349" style={{ marginBottom: '12px' }} />
                    <p style={{ color: '#8892a4', margin: 0 }}>尚無觀點記錄</p>
                    <p style={{ color: '#8892a4', fontSize: '13px', margin: '6px 0 0' }}>點上方「新增觀點」開始記錄你的判斷</p>
                </div>
            ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                    {filtered.map(record => {
                        const { verdict, changePct } = calcVerdict(record)
                        const days = daysSince(record.createdAt)
                        const isLosingBull = record.direction === 'bull' && verdict === 'lose'
                        const isLosingBear = record.direction === 'bear' && verdict === 'lose'
                        const dirColor = record.direction === 'bull' ? '#00c896' : '#ff5757'

                        return (
                            <div key={record.id} style={{
                                ...card,
                                borderLeft: `3px solid ${record.direction === 'bull' ? '#00c896' : '#ff5757'}`,
                                position: 'relative',
                            }}>
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '12px', flexWrap: 'wrap' }}>
                                    {/* 左側：股票資訊 */}
                                    <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
                                        {/* 方向 badge */}
                                        <div style={{
                                            display: 'flex', alignItems: 'center', gap: '4px',
                                            backgroundColor: record.direction === 'bull' ? 'rgba(0,200,150,0.12)' : 'rgba(255,87,87,0.12)',
                                            color: dirColor, borderRadius: '8px', padding: '4px 10px',
                                            fontSize: '13px', fontWeight: 700,
                                        }}>
                                            {record.direction === 'bull'
                                                ? <TrendingUp size={13} />
                                                : <TrendingDown size={13} />}
                                            {record.direction === 'bull' ? '看多' : '看空'}
                                        </div>

                                        {/* 股票名稱 */}
                                        <div>
                                            <span style={{ fontWeight: 700, color: '#e2e8f0', fontSize: '15px' }}>{record.code}</span>
                                            {record.name && record.name !== record.code && (
                                                <span style={{ color: '#8892a4', fontSize: '13px', marginLeft: '6px' }}>{record.name}</span>
                                            )}
                                        </div>

                                        {/* 勝負 badge */}
                                        <span style={verdictStyle(verdict)}>{verdictLabel(verdict)}</span>
                                    </div>

                                    {/* 右側：價格與操作 */}
                                    <div style={{ display: 'flex', alignItems: 'center', gap: '16px', flexWrap: 'wrap' }}>
                                        {/* 價格對比 */}
                                        <div style={{ textAlign: 'right' }}>
                                            <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
                                                <div>
                                                    <div style={{ fontSize: '10px', color: '#8892a4' }}>記錄價</div>
                                                    <div style={{ fontSize: '14px', fontWeight: 600, color: '#e2e8f0' }}>
                                                        {record.recordPrice > 0 ? `$${record.recordPrice.toFixed(2)}` : '—'}
                                                    </div>
                                                </div>
                                                <Minus size={12} color="#2e3349" />
                                                <div>
                                                    <div style={{ fontSize: '10px', color: '#8892a4' }}>現價</div>
                                                    <div style={{ fontSize: '14px', fontWeight: 600, color: record.currentPrice ? '#e2e8f0' : '#8892a4' }}>
                                                        {record.currentPrice ? `$${record.currentPrice.toFixed(2)}` : '—'}
                                                    </div>
                                                </div>
                                                {changePct !== null && (
                                                    <div style={{
                                                        fontSize: '13px', fontWeight: 700,
                                                        color: changePct > 0 ? '#00c896' : changePct < 0 ? '#ff5757' : '#8892a4',
                                                    }}>
                                                        {changePct > 0 ? '+' : ''}{changePct.toFixed(2)}%
                                                    </div>
                                                )}
                                            </div>
                                        </div>

                                        {/* 刪除 */}
                                        <button
                                            onClick={() => record.id && handleDelete(record.id)}
                                            disabled={deletingId === record.id}
                                            style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#8892a4', padding: '4px', display: 'flex', opacity: deletingId === record.id ? 0.4 : 1 }}
                                            onMouseEnter={e => (e.currentTarget.style.color = '#ff5757')}
                                            onMouseLeave={e => (e.currentTarget.style.color = '#8892a4')}
                                        >
                                            <Trash2 size={15} />
                                        </button>
                                    </div>
                                </div>

                                {/* 理由 */}
                                {record.reason && (
                                    <div style={{
                                        marginTop: '10px', padding: '8px 12px',
                                        backgroundColor: '#0f1117', borderRadius: '8px',
                                        fontSize: '13px', color: '#8892a4', lineHeight: 1.5,
                                        borderLeft: `2px solid ${dirColor}`,
                                    }}>
                                        {record.reason}
                                    </div>
                                )}

                                {/* 時間資訊 */}
                                <div style={{ marginTop: '8px', fontSize: '11px', color: '#8892a4', display: 'flex', gap: '12px' }}>
                                    <span>📅 記錄於 {record.createdAt}</span>
                                    <span>⏱ 已過 {days} 天</span>
                                </div>
                            </div>
                        )
                    })}
                </div>
            )}
        </div>
    )
}