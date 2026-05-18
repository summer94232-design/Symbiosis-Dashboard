import { useState, useEffect, useMemo } from 'react'
import { getDocs, setDoc, deleteDoc, orderBy, query, getDoc } from 'firebase/firestore'
import { investDB } from '../../lib/firebase'
import { userCol, userDoc, userDocNested } from '../../lib/userDB'
import { calcPositions, calcAvailableCash, type TradeRecord, type DividendRecord } from '../../lib/calc'
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend, ReferenceLine } from 'recharts'
import { Save, Pencil, Trash2, Plus, X, Check, Zap, AlertTriangle, TrendingUp } from 'lucide-react'

// ── 型別 ──────────────────────────────────────────────────────────────────

interface SnapshotRecord {
    date: string
    totalAssets: number
    marketValue: number
    cash: number
    marginDebt?: number  // 融資借款（負債），記錄用，總資產已扣除
}

const emptySnap: SnapshotRecord = {
    date: new Date().toISOString().split('T')[0],
    totalAssets: 0, marketValue: 0, cash: 0, marginDebt: 0
}

// ── 樣式常數 ──────────────────────────────────────────────────────────────

const card: React.CSSProperties = { backgroundColor: 'var(--c-sidebar)', border: '1px solid var(--c-border)', borderRadius: '12px', padding: '20px' }
const inp: React.CSSProperties = { backgroundColor: 'var(--c-bg)', border: '1px solid var(--c-border)', borderRadius: '8px', padding: '8px 12px', color: 'var(--c-text)', fontSize: '14px', width: '100%', outline: 'none', boxSizing: 'border-box' }
const lbl: React.CSSProperties = { fontSize: '12px', color: 'var(--c-muted)', display: 'block', marginBottom: '4px' }
const btn = (color: string): React.CSSProperties => ({ backgroundColor: color, border: 'none', borderRadius: '8px', padding: '8px 16px', color: '#fff', fontSize: '14px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px' })

// ── Tooltip：金額模式 ──────────────────────────────────────────────────────

interface TooltipPayloadItem { name: string; value: number; color: string }
interface CustomTooltipProps { active?: boolean; payload?: TooltipPayloadItem[]; label?: string }

const CustomTooltip = ({ active, payload, label }: CustomTooltipProps) => {
    if (!active || !payload?.length) return null
    return (
        <div style={{ backgroundColor: 'var(--c-card)', border: '1px solid var(--c-border)', borderRadius: '8px', padding: '12px 16px' }}>
            <p style={{ color: 'var(--c-muted)', fontSize: '12px', margin: '0 0 8px' }}>{label}</p>
            {payload.map((p) => (
                <p key={p.name} style={{ color: p.color, fontSize: '14px', fontWeight: 600, margin: '2px 0' }}>
                    {p.name}：${Number(p.value).toLocaleString()}
                </p>
            ))}
        </div>
    )
}

// ── Tooltip：報酬率模式 ────────────────────────────────────────────────────

const ReturnTooltip = ({ active, payload, label }: any) => {
    if (!active || !payload?.length) return null
    return (
        <div style={{ backgroundColor: 'var(--c-card)', border: '1px solid var(--c-border)', borderRadius: '8px', padding: '12px 16px' }}>
            <p style={{ color: 'var(--c-muted)', fontSize: '12px', margin: '0 0 8px' }}>{label}</p>
            {payload.map((p: any) =>
                p.value != null && (
                    <p key={p.name} style={{ color: p.color, fontSize: '14px', fontWeight: 600, margin: '2px 0' }}>
                        {p.name}：{p.value >= 0 ? '+' : ''}{Number(p.value).toFixed(2)}%
                    </p>
                )
            )}
        </div>
    )
}

// ── 融資借款計算（從交易紀錄彙總現有借款）────────────────────────────────

function calcMarginDebt(trades: TradeRecord[]): number {
    const marginMap: Record<string, { shares: number; marginAmount: number }> = {}
    for (const t of trades) {
        if (!t.isMargin) continue
        if (!marginMap[t.code]) {
            marginMap[t.code] = { shares: 0, marginAmount: 0 }
        }
        const pos = marginMap[t.code]
        if (t.type === 'buy') {
            const stockVal = t.price * t.shares
            const mAmt = (t as any).marginAmount ?? Math.floor(stockVal * ((t as any).marginRatio ?? 0.6))
            pos.shares += t.shares
            pos.marginAmount += mAmt
        } else if (t.type === 'sell' && pos.shares > 0) {
            const ratio = t.shares / pos.shares
            pos.marginAmount -= pos.marginAmount * ratio
            pos.shares -= t.shares
        }
    }
    return Object.values(marginMap)
        .filter(m => m.shares > 0 && m.marginAmount > 0)
        .reduce((s, m) => s + m.marginAmount, 0)
}

// ── 主元件 ────────────────────────────────────────────────────────────────

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

    // ── Benchmark 相關 state ──────────────────────────────────────────────
    // chartMode: 'absolute' = 金額模式；'return' = 報酬率對比模式
    const [chartMode, setChartMode] = useState<'absolute' | 'return'>('absolute')
    const [showBenchmark, setShowBenchmark] = useState(true)
    // taiexData: date (YYYY-MM-DD) → 收盤指數點數
    // 純前端 state，不寫入 Firebase，重新整理後重抓
    const [taiexData, setTaiexData] = useState<Record<string, number>>({})
    const [taiexLoading, setTaiexLoading] = useState(false)
    const [taiexError, setTaiexError] = useState<string | null>(null)

    // ── 載入快照 ──────────────────────────────────────────────────────────

    const loadSnapshots = async () => {
        setLoading(true)
        const q = query(userCol(investDB, 'assetSnapshots'), orderBy('date', 'asc'))
        const snap = await getDocs(q)
        setSnapshots(snap.docs.map(d => d.data() as SnapshotRecord))
        setLoading(false)
    }

    useEffect(() => { loadSnapshots() }, [])

    // ── 抓取加權指數歷史資料（Fugle API）─────────────────────────────────
    //
    // Fugle historical candles 回傳格式：
    //   { symbol, type, exchange, market, data: [{ date, open, high, low, close, volume, ... }, ...] }
    // 加權指數在 Fugle 的 symbol 為 "IR0001"（非 TAIEX）
    // 資料僅存於前端 state，不寫入 Firebase

    // 加權指數在 Fugle 的正確代號為 "IX0001"
    // 使用 Fugle historical/candles endpoint 抓歷史收盤點數
    // 資料僅存於前端 state，不寫入 Firebase
    const fetchTAIEX = async (fromDate: string) => {
        setTaiexLoading(true)
        setTaiexError(null)
        try {
            const today = new Date().toISOString().split('T')[0]
            const apiKey = import.meta.env.VITE_FUGLE_API_KEY
            const url = `https://api.fugle.tw/marketdata/v1.0/stock/historical/candles/IX0001?from=${fromDate}&to=${today}&fields=close&sort=asc`
            const res = await fetch(url, { headers: { 'X-API-KEY': apiKey } })
            if (!res.ok) {
                const err = await res.json().catch(() => ({}))
                throw new Error(`HTTP ${res.status}: ${err?.message ?? res.statusText}`)
            }
            const raw = await res.json()
            if (!raw.data || raw.data.length === 0) throw new Error('回傳資料為空')

            const map: Record<string, number> = {}
            for (const candle of raw.data) {
                if (candle.date && candle.close != null) {
                    map[candle.date] = candle.close
                }
            }
            setTaiexData(map)
        } catch (err: any) {
            console.error('[IX0001] fetch failed:', err)
            setTaiexError(`加權指數載入失敗：${err?.message ?? err}`)
        }
        setTaiexLoading(false)
    }

    const handleRefreshTAIEX = (currentSnapshots = snapshots) => {
        // 往第一筆快照日期前推 7 天，確保有對應收盤價
        const earliest = currentSnapshots.length > 0
            ? new Date(new Date(currentSnapshots[0].date).getTime() - 7 * 86400000).toISOString().split('T')[0]
            : '2020-01-01'
        fetchTAIEX(earliest)
    }

    // 切換到報酬率模式且 benchmark 開啟時，若尚無資料則自動抓取
    useEffect(() => {
        if (chartMode === 'return' && showBenchmark && Object.keys(taiexData).length === 0 && !taiexLoading) {
            handleRefreshTAIEX()
        }
    }, [chartMode, showBenchmark])

    // ── 市值計算 ──────────────────────────────────────────────────────────

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

    // ── 自動帶入（含扣除融資借款）────────────────────────────────────────

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

            // ✅ 計算融資借款並從總資產扣除，呈現真實淨值
            const marginDebt = calcMarginDebt(trades)
            const totalAssets = marketValue + cash - marginDebt

            setForm(f => ({
                ...f,
                totalAssets: Math.round(totalAssets),
                marketValue: Math.round(marketValue),
                cash: Math.round(cash),
                marginDebt: Math.round(marginDebt),
            }))
        } catch (err) { console.error(err) }
        setAutoLoading(false)
    }

    // ── 儲存今日快照（含扣除融資借款）───────────────────────────────────

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

            // ✅ 計算融資借款並從總資產扣除，呈現真實淨值
            const marginDebt = calcMarginDebt(trades)
            const totalAssets = marketValue + cash - marginDebt
            const today = new Date().toISOString().split('T')[0]

            await setDoc(userDoc(investDB, 'assetSnapshots', today), {
                date: today,
                totalAssets: Math.round(totalAssets),
                marketValue: Math.round(marketValue),
                cash: Math.round(cash),
                marginDebt: Math.round(marginDebt),
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

    // ── 時間範圍篩選 ──────────────────────────────────────────────────────

    const filterByRange = (data: SnapshotRecord[]) => {
        if (range === 'ALL') return data
        const now = new Date()
        const months = range === '1M' ? 1 : range === '3M' ? 3 : range === '6M' ? 6 : 12
        const cutoff = new Date(now.getFullYear(), now.getMonth() - months, now.getDate()).toISOString().split('T')[0]
        return data.filter(d => d.date >= cutoff)
    }

    const filtered = filterByRange(snapshots)
    const latest = snapshots[snapshots.length - 1]

    // ── Y 軸範圍（金額模式）──────────────────────────────────────────────

    const yDomain = useMemo((): [number, number] | ['auto', 'auto'] => {
        if (filtered.length < 2) return ['auto', 'auto']
        const vals = filtered.map(d => d.totalAssets)
        const minVal = Math.min(...vals)
        const maxVal = Math.max(...vals)
        const span = maxVal - minVal
        const padding = span * 0.1 || maxVal * 0.05
        const step = 10000
        return [
            Math.floor((minVal - padding) / step) * step,
            Math.ceil((maxVal + padding) / step) * step
        ]
    }, [filtered])

    // ── 報酬率對比資料（報酬率模式）──────────────────────────────────────
    //
    // 以 filtered 第一筆快照為基準點（= 0%）
    // TAIEX 找「≤ 該日期」最近一個有收盤的交易日對齊

    const returnChartData = useMemo(() => {
        if (filtered.length < 2) return []

        const sortedDates = Object.keys(taiexData).sort()
        const getClosestTAIEX = (date: string): number | null => {
            const before = sortedDates.filter(d => d <= date)
            if (!before.length) return null
            return taiexData[before[before.length - 1]]
        }

        const baseDate = filtered[0].date
        const baseAsset = filtered[0].totalAssets
        const baseTAIEX = getClosestTAIEX(baseDate)

        return filtered.map(d => {
            const taiexClose = getClosestTAIEX(d.date)
            return {
                date: d.date,
                assetReturn: parseFloat(((d.totalAssets - baseAsset) / baseAsset * 100).toFixed(2)),
                taiexReturn: baseTAIEX != null && taiexClose != null
                    ? parseFloat(((taiexClose - baseTAIEX) / baseTAIEX * 100).toFixed(2))
                    : null,
            }
        })
    }, [filtered, taiexData])

    // ── 超額報酬（最後一筆）──────────────────────────────────────────────

    const excessReturn = useMemo(() => {
        if (!returnChartData.length) return null
        const last = returnChartData[returnChartData.length - 1]
        if (last.taiexReturn == null) return null
        return parseFloat((last.assetReturn - last.taiexReturn).toFixed(2))
    }, [returnChartData])

    // ── 渲染 ──────────────────────────────────────────────────────────────

    return (
        <>
            <style>{`
                @keyframes spin { from { transform: rotate(0deg) } to { transform: rotate(360deg) } }
                .snap-form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
                @media (max-width: 600px) { .snap-form-grid { grid-template-columns: 1fr; } }
            `}</style>
            <div style={{ padding: '24px', maxWidth: '900px', margin: '0 auto' }}>

                {/* ── 標題列 ── */}
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '24px', flexWrap: 'wrap', gap: '12px' }}>
                    <h2 style={{ fontSize: '20px', fontWeight: 700, color: 'var(--c-text)', margin: 0 }}>資產趨勢</h2>
                    <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                        <button onClick={saveToday} disabled={saving} style={btn('var(--c-positive)')}>
                            <Save size={15} style={{ animation: saving ? 'spin 1s linear infinite' : 'none' }} />
                            {saving ? '儲存中...' : '儲存今日快照'}
                        </button>
                        <button onClick={() => { setShowForm(true); setEditingDate(null); setForm(emptySnap) }} style={btn('var(--c-accent)')}>
                            <Plus size={15} />手動新增
                        </button>
                    </div>
                </div>

                {/* ── 最新數字摘要 ── */}
                {latest && (
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '12px', marginBottom: '24px' }}>
                        {[
                            { label: '總淨值', value: latest.totalAssets, color: 'var(--c-accent)' },
                            { label: '股票市值', value: latest.marketValue, color: 'var(--c-positive)' },
                            { label: '現金', value: latest.cash, color: 'var(--c-warning)' },
                            ...(latest.marginDebt && latest.marginDebt > 0
                                ? [{ label: '融資借款', value: latest.marginDebt, color: 'var(--c-danger)' }]
                                : []),
                        ].map(item => (
                            <div key={item.label} style={card}>
                                <div style={{ fontSize: '12px', color: 'var(--c-muted)', marginBottom: '6px' }}>{item.label}</div>
                                <div style={{ fontSize: '20px', fontWeight: 700, color: item.color }}>
                                    {item.label === '融資借款' ? '-' : ''}${item.value.toLocaleString()}
                                </div>
                            </div>
                        ))}
                    </div>
                )}

                {/* ── 趨勢圖區塊 ── */}
                <div style={{ ...card, marginBottom: '24px' }}>

                    {/* 工具列 */}
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px', flexWrap: 'wrap', gap: '8px' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
                            <span style={{ fontSize: '14px', fontWeight: 600, color: 'var(--c-text)' }}>資產走勢圖</span>

                            {/* 金額 / 報酬率對比 切換 */}
                            <div style={{ display: 'flex', backgroundColor: 'var(--c-bg)', borderRadius: '8px', padding: '3px', gap: '2px' }}>
                                {(['absolute', 'return'] as const).map(mode => (
                                    <button
                                        key={mode}
                                        onClick={() => setChartMode(mode)}
                                        style={{
                                            backgroundColor: chartMode === mode ? 'var(--c-card)' : 'transparent',
                                            border: chartMode === mode ? '1px solid var(--c-border)' : '1px solid transparent',
                                            borderRadius: '6px', padding: '3px 10px',
                                            color: chartMode === mode ? 'var(--c-text)' : 'var(--c-muted)',
                                            fontSize: '12px', cursor: 'pointer',
                                            fontWeight: chartMode === mode ? 600 : 400
                                        }}
                                    >
                                        {mode === 'absolute' ? '金額' : '報酬率對比'}
                                    </button>
                                ))}
                            </div>

                            {/* 加權指數 toggle（僅報酬率模式顯示） */}
                            {chartMode === 'return' && (
                                <button
                                    onClick={() => {
                                        const next = !showBenchmark
                                        setShowBenchmark(next)
                                        if (next && Object.keys(taiexData).length === 0 && !taiexLoading) {
                                            handleRefreshTAIEX()
                                        }
                                    }}
                                    style={{
                                        backgroundColor: showBenchmark ? 'color-mix(in srgb, var(--c-warning) 12%, transparent)' : 'var(--c-bg)',
                                        border: `1px solid ${showBenchmark ? 'var(--c-warning)' : 'var(--c-border)'}`,
                                        borderRadius: '6px', padding: '3px 10px',
                                        color: showBenchmark ? 'var(--c-warning)' : 'var(--c-muted)',
                                        fontSize: '12px', cursor: 'pointer',
                                        display: 'flex', alignItems: 'center', gap: '4px'
                                    }}
                                >
                                    <TrendingUp size={12} />
                                    {taiexLoading ? '載入中...' : '加權指數 TAIEX'}
                                </button>
                            )}
                        </div>

                        {/* 時間範圍 */}
                        <div style={{ display: 'flex', gap: '6px' }}>
                            {(['1M', '3M', '6M', '1Y', 'ALL'] as const).map(r => (
                                <button
                                    key={r}
                                    onClick={() => setRange(r)}
                                    style={{
                                        backgroundColor: range === r ? 'var(--c-accent)' : 'var(--c-card)',
                                        border: '1px solid', borderColor: range === r ? 'var(--c-accent)' : 'var(--c-border)',
                                        borderRadius: '6px', padding: '4px 12px',
                                        color: range === r ? '#fff' : 'var(--c-muted)',
                                        fontSize: '13px', cursor: 'pointer'
                                    }}
                                >
                                    {r}
                                </button>
                            ))}
                        </div>
                    </div>

                    {/* TAIEX 錯誤提示 */}
                    {taiexError && chartMode === 'return' && (
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', backgroundColor: 'rgba(255,87,87,0.1)', border: '1px solid rgba(255,87,87,0.3)', borderRadius: '8px', padding: '8px 14px', marginBottom: '12px', fontSize: '12px', color: 'var(--c-danger)' }}>
                            <AlertTriangle size={13} style={{ flexShrink: 0 }} />
                            {taiexError}
                            <button
                                onClick={() => handleRefreshTAIEX()}
                                style={{ marginLeft: 'auto', background: 'none', border: '1px solid var(--c-danger)', borderRadius: '4px', color: 'var(--c-danger)', fontSize: '11px', padding: '2px 8px', cursor: 'pointer' }}
                            >
                                重試
                            </button>
                        </div>
                    )}

                    {/* 超額報酬標籤 */}
                    {chartMode === 'return' && showBenchmark && excessReturn !== null && (
                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '12px', fontSize: '13px', color: 'var(--c-muted)' }}>
                            <span>同期超額報酬：</span>
                            <span style={{ fontWeight: 700, color: excessReturn >= 0 ? 'var(--c-positive)' : 'var(--c-danger)' }}>
                                {excessReturn >= 0 ? '+' : ''}{excessReturn}%
                            </span>
                            <span style={{ fontSize: '11px', color: '#4a5568' }}>（以首筆快照 {filtered[0]?.date} 為基準）</span>
                        </div>
                    )}

                    {/* 圖表本體 */}
                    {loading ? (
                        <div style={{ textAlign: 'center', padding: '48px', color: 'var(--c-muted)' }}>載入中...</div>
                    ) : filtered.length < 2 ? (
                        <div style={{ textAlign: 'center', padding: '48px', color: 'var(--c-muted)' }}>
                            <p style={{ fontSize: '15px' }}>資料不足，無法顯示趨勢圖</p>
                            <p style={{ fontSize: '13px', marginTop: '8px' }}>請累積至少 2 筆資料</p>
                        </div>
                    ) : chartMode === 'absolute' ? (

                        // ── 金額模式：只顯示總資產（淨值）──
                        <ResponsiveContainer width="100%" height={320}>
                            <LineChart data={filtered} margin={{ top: 5, right: 20, left: 10, bottom: 5 }}>
                                <CartesianGrid strokeDasharray="3 3" stroke="var(--c-border)" />
                                <XAxis dataKey="date" tick={{ fill: 'var(--c-muted)', fontSize: 12 }} tickFormatter={d => d.slice(5)} />
                                <YAxis
                                    domain={yDomain}
                                    tick={{ fill: 'var(--c-muted)', fontSize: 12 }}
                                    tickFormatter={v => `${(v / 10000).toFixed(0)}萬`}
                                    width={60}
                                />
                                <Tooltip content={<CustomTooltip />} />
                                <Line
                                    type="monotone"
                                    dataKey="totalAssets"
                                    name="總淨值"
                                    stroke="var(--c-accent)"
                                    strokeWidth={2.5}
                                    dot={false}
                                    activeDot={{ r: 5, fill: 'var(--c-accent)' }}
                                />
                            </LineChart>
                        </ResponsiveContainer>

                    ) : (

                        // ── 報酬率對比模式：我的資產 vs 加權指數 ──
                        <ResponsiveContainer width="100%" height={320}>
                            <LineChart data={returnChartData} margin={{ top: 5, right: 20, left: 10, bottom: 5 }}>
                                <CartesianGrid strokeDasharray="3 3" stroke="var(--c-border)" />
                                <XAxis dataKey="date" tick={{ fill: 'var(--c-muted)', fontSize: 12 }} tickFormatter={d => d.slice(5)} />
                                <YAxis
                                    tick={{ fill: 'var(--c-muted)', fontSize: 12 }}
                                    tickFormatter={v => `${v >= 0 ? '+' : ''}${v.toFixed(0)}%`}
                                    width={64}
                                />
                                <Tooltip content={<ReturnTooltip />} />
                                <Legend
                                    wrapperStyle={{ fontSize: '13px', paddingTop: '8px' }}
                                    formatter={(value) => <span style={{ color: '#c8d0e0' }}>{value}</span>}
                                />
                                <ReferenceLine y={0} stroke="var(--c-border)" strokeWidth={1.5} />
                                <Line
                                    type="monotone"
                                    dataKey="assetReturn"
                                    name="我的資產"
                                    stroke="var(--c-accent)"
                                    strokeWidth={2.5}
                                    dot={false}
                                    activeDot={{ r: 5, fill: 'var(--c-accent)' }}
                                    connectNulls
                                />
                                {showBenchmark && (
                                    <Line
                                        type="monotone"
                                        dataKey="taiexReturn"
                                        name="加權指數 TAIEX"
                                        stroke="var(--c-warning)"
                                        strokeWidth={2}
                                        strokeDasharray="6 3"
                                        dot={false}
                                        activeDot={{ r: 4, fill: 'var(--c-warning)' }}
                                        connectNulls
                                    />
                                )}
                            </LineChart>
                        </ResponsiveContainer>
                    )}

                    {/* 說明文字 */}
                    {chartMode === 'return' && filtered.length >= 2 && (
                        <p style={{ fontSize: '11px', color: '#4a5568', margin: '10px 0 0', textAlign: 'right' }}>
                            資料來源：Fugle MarketData｜以首筆快照為基準點（0%）正規化對比
                        </p>
                    )}
                </div>

                {/* ── 新增 / 編輯表單 ── */}
                {showForm && (
                    <div style={{ ...card, marginBottom: '24px', border: '1px solid var(--c-accent)' }}>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
                            <span style={{ fontSize: '14px', fontWeight: 600, color: 'var(--c-text)' }}>
                                {editingDate ? '✏️ 編輯紀錄' : '➕ 手動新增紀錄'}
                            </span>
                            <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                                <button onClick={handleAutoFill} disabled={autoLoading} style={{ ...btn('var(--c-positive)'), fontSize: '13px', padding: '6px 12px' }}>
                                    <Zap size={13} style={{ animation: autoLoading ? 'spin 1s linear infinite' : 'none' }} />
                                    {autoLoading ? '計算中...' : '自動帶入'}
                                </button>
                                <button onClick={handleCancel} style={{ background: 'none', border: 'none', color: 'var(--c-muted)', cursor: 'pointer' }}>
                                    <X size={18} />
                                </button>
                            </div>
                        </div>
                        <p style={{ fontSize: '12px', color: 'var(--c-muted)', margin: '0 0 16px' }}>
                            點「自動帶入」會從 Firebase 計算目前持倉市值與現金，並自動扣除融資借款
                        </p>

                        {missingPriceCodes.length > 0 && (
                            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', backgroundColor: 'rgba(245,166,35,0.1)', border: '1px solid rgba(245,166,35,0.3)', borderRadius: '8px', padding: '10px 14px', marginBottom: '16px', fontSize: '12px', color: 'var(--c-warning)' }}>
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
                                <label style={lbl}>總淨值（已扣融資）</label>
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
                            <div>
                                <label style={lbl}>融資借款（負債）</label>
                                <input
                                    type="number"
                                    style={{ ...inp, color: 'var(--c-danger)' }}
                                    placeholder="0"
                                    value={form.marginDebt || ''}
                                    onChange={e => {
                                        const debt = parseFloat(e.target.value) || 0
                                        setForm(f => ({
                                            ...f,
                                            marginDebt: debt,
                                            totalAssets: Math.round(f.marketValue + f.cash - debt),
                                        }))
                                    }}
                                />
                            </div>
                        </div>
                        <div style={{ display: 'flex', gap: '8px', marginTop: '16px', justifyContent: 'flex-end' }}>
                            <button style={btn('var(--c-border)')} onClick={handleCancel}><X size={14} />取消</button>
                            <button style={btn('var(--c-accent)')} onClick={handleSave} disabled={formLoading}>
                                <Check size={14} />{formLoading ? '儲存中...' : '確認儲存'}
                            </button>
                        </div>
                    </div>
                )}

                {/* ── 歷史快照列表（不顯示 TAIEX 資料）── */}
                <div style={card}>
                    <span style={{ fontSize: '14px', fontWeight: 600, color: 'var(--c-text)', display: 'block', marginBottom: '16px' }}>
                        歷史快照紀錄
                        <span style={{ fontSize: '12px', color: 'var(--c-muted)', fontWeight: 400, marginLeft: '8px' }}>（共 {snapshots.length} 筆）</span>
                    </span>
                    {snapshots.length === 0 ? (
                        <div style={{ textAlign: 'center', padding: '32px', color: 'var(--c-muted)', fontSize: '14px' }}>
                            尚無資料，請點「儲存今日快照」新增
                        </div>
                    ) : (
                        <div style={{ overflowX: 'auto' }}>
                            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                                <thead>
                                    <tr style={{ borderBottom: '1px solid var(--c-border)' }}>
                                        <th style={{ padding: '8px 12px', color: 'var(--c-muted)', fontWeight: 500, textAlign: 'left', whiteSpace: 'nowrap' }}>日期</th>
                                        <th style={{ padding: '8px 12px', color: 'var(--c-muted)', fontWeight: 500, textAlign: 'right', whiteSpace: 'nowrap' }}>總淨值</th>
                                        <th style={{ padding: '8px 12px', color: 'var(--c-muted)', fontWeight: 500, textAlign: 'right', whiteSpace: 'nowrap' }}>股票市值</th>
                                        <th style={{ padding: '8px 12px', color: 'var(--c-muted)', fontWeight: 500, textAlign: 'right', whiteSpace: 'nowrap' }}>現金</th>
                                        <th style={{ padding: '8px 12px', color: 'var(--c-muted)', fontWeight: 500, textAlign: 'right', whiteSpace: 'nowrap' }}>融資借款</th>
                                        <th style={{ padding: '8px 12px', color: 'var(--c-muted)', fontWeight: 500, textAlign: 'center', whiteSpace: 'nowrap' }}>操作</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {[...snapshots].reverse().map(s => (
                                        <tr key={s.date} style={{ borderBottom: '1px solid #1e2235' }}>
                                            <td style={{ padding: '10px 12px', color: '#c8d0e0' }}>{s.date}</td>
                                            <td style={{ padding: '10px 12px', color: 'var(--c-accent)', fontWeight: 600, textAlign: 'right' }}>${s.totalAssets.toLocaleString()}</td>
                                            <td style={{ padding: '10px 12px', color: 'var(--c-positive)', textAlign: 'right' }}>${s.marketValue.toLocaleString()}</td>
                                            <td style={{ padding: '10px 12px', color: 'var(--c-warning)', textAlign: 'right' }}>${s.cash.toLocaleString()}</td>
                                            <td style={{ padding: '10px 12px', color: s.marginDebt && s.marginDebt > 0 ? 'var(--c-danger)' : 'var(--c-muted)', textAlign: 'right' }}>
                                                {s.marginDebt && s.marginDebt > 0 ? `-$${s.marginDebt.toLocaleString()}` : '—'}
                                            </td>
                                            <td style={{ padding: '10px 12px', textAlign: 'center' }}>
                                                <div style={{ display: 'flex', gap: '6px', justifyContent: 'center' }}>
                                                    <button
                                                        onClick={() => handleEdit(s)}
                                                        style={{ background: 'none', border: '1px solid var(--c-border)', borderRadius: '6px', padding: '4px 8px', color: 'var(--c-muted)', cursor: 'pointer', display: 'flex', alignItems: 'center' }}
                                                    >
                                                        <Pencil size={13} />
                                                    </button>
                                                    <button
                                                        onClick={() => handleDelete(s.date)}
                                                        style={{ background: 'none', border: '1px solid var(--c-border)', borderRadius: '6px', padding: '4px 8px', color: 'var(--c-danger)', cursor: 'pointer', display: 'flex', alignItems: 'center' }}
                                                    >
                                                        <Trash2 size={13} />
                                                    </button>
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