import { getHistoricalCandles } from '../../lib/history'
import LoadingState from '../../components/LoadingState'
import { card, inp, lbl, btn } from '../../ui/styles'
import { confirmAction } from '../../ui/dialogs'
import { buildTimeWeightedReturns, buildRestartedTimeWeightedReturns } from '../../lib/performanceReturns'
import { buildTodaySnapshot, saveValuationSnapshot } from '../../lib/snapshot'
import { useState, useEffect, useMemo, useEffectEvent, useRef } from 'react'
import { setDoc, deleteDoc, getDoc } from 'firebase/firestore'
import { investDB } from '../../lib/firebase'
import { captureUserSession, userDoc, userDocNested } from '../../lib/userDB'
import { fetchCashflow, fetchAssetSnapshots, fetchDividends, fetchTrades, invalidateAssetSnapshots } from '../../lib/investData'
import { loadPortfolioSnapshot } from '../../lib/portfolioSnapshot'
import { reconcileSnapshotBreakdowns, type DividendRecord, type TradeRecord } from '../../lib/calc'
import { toLocalDateString } from '../../lib/date'
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend, ReferenceLine } from 'recharts'
import { Save, Pencil, Trash2, Plus, X, Check, Zap, AlertTriangle, TrendingUp } from 'lucide-react'
import { useInvestSync } from '../../InvestSyncContext'
import { validateSnapshotForWrite } from '../../lib/investmentValidation'
import { calculateReturnGap } from '../../lib/returnComparison'

// ── 型別 ──────────────────────────────────────────────────────────────────

interface SnapshotRecord {
    valuationQuality?: 'closing' | 'intraday' | 'manual-unverified'
    valuationAt?: string
    date: string
    totalAssets: number
    marketValue: number
    cash: number
    marginDebt?: number  // 融資借款（負債），記錄用，總資產已扣除
    auto?: boolean       // ✅ 5-1：由自動快照寫入時為 true
    cashflowBasis?: string
    cashflowNetAtCapture?: number
}

const emptySnap: SnapshotRecord = {
    date: toLocalDateString(),
    totalAssets: 0, marketValue: 0, cash: 0, marginDebt: 0
}

// ── 樣式常數 ──────────────────────────────────────────────────────────────


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

interface ReturnTooltipPayloadItem {
    name: string
    value?: number | null
    color: string
    dataKey?: string
}

interface ReturnTooltipProps {
    active?: boolean
    payload?: ReturnTooltipPayloadItem[]
    label?: string
}

const ReturnTooltip = ({ active, payload, label }: ReturnTooltipProps) => {
    if (!active || !payload?.length) return null
    const assetReturn = payload.find(item => item.dataKey === 'assetReturn')?.value
    const taiexReturn = payload.find(item => item.dataKey === 'taiexReturn')?.value
    const returnGap = calculateReturnGap(assetReturn, taiexReturn)
    const tooltipLabel = (item: ReturnTooltipPayloadItem) => {
        if (item.dataKey === 'assetReturn') return '我的資產'
        if (item.dataKey === 'taiexReturn') return '加權指數'
        return item.name
    }

    return (
        <div style={{ backgroundColor: 'var(--c-card)', border: '1px solid var(--c-border)', borderRadius: '8px', padding: '12px 16px' }}>
            <p style={{ color: 'var(--c-muted)', fontSize: '12px', margin: '0 0 8px' }}>{label}</p>
            {payload.map((p) =>
                p.value != null && (
                    <p key={p.name} style={{ color: p.color, fontSize: '14px', fontWeight: 600, margin: '2px 0' }}>
                        {tooltipLabel(p)}：{p.value >= 0 ? '+' : ''}{Number(p.value).toFixed(2)}%
                    </p>
                )
            )}
            {returnGap != null && (
                <p
                    title="資產報酬率減去加權指數報酬率"
                    style={{
                        color: returnGap > 0 ? 'var(--c-positive)' : returnGap < 0 ? 'var(--c-danger)' : 'var(--c-muted)',
                        fontSize: '14px',
                        fontWeight: 600,
                        margin: '2px 0',
                    }}
                >
                    同期報酬：{returnGap >= 0 ? '+' : ''}{returnGap.toFixed(2)}%
                </p>
            )}
        </div>
    )
}

// ── 主元件 ────────────────────────────────────────────────────────────────

export default function AssetTrend() {
    const { version: syncVersion } = useInvestSync()
    const snapshotRequest = useRef(0)
    const [snapshots, setSnapshots] = useState<SnapshotRecord[]>([])
    const [loading, setLoading] = useState(true)
    const [hasLoaded, setHasLoaded] = useState(false)
    const [saving, setSaving] = useState(false)
    const [autoLoading, setAutoLoading] = useState(false)
    const [range, setRange] = useState<'1M' | '3M' | '6M' | '1Y' | 'ALL'>('3M')
    const [showForm, setShowForm] = useState(false)
    const [editingDate, setEditingDate] = useState<string | null>(null)
    const [form, setForm] = useState<SnapshotRecord>(emptySnap)
    const [formLoading, setFormLoading] = useState(false)
    const [missingPriceCodes, setMissingPriceCodes] = useState<string[]>([])
    const [formError, setFormError] = useState('')

    // ── Benchmark 相關 state ──────────────────────────────────────────────
    // chartMode: 'absolute' = 金額模式；'return' = 報酬率對比模式
    const [chartMode, setChartMode] = useState<'absolute' | 'return'>('absolute')
    const [restartIncomplete, setRestartIncomplete] = useState(false)
    const [showBenchmark, setShowBenchmark] = useState(true)
    // taiexData: date (YYYY-MM-DD) → 收盤指數點數
    // 純前端 state，不寫入 Firebase，重新整理後重抓
    const [taiexData, setTaiexData] = useState<Record<string, number>>({})
    const [taiexLoading, setTaiexLoading] = useState(false)
    const [taiexError, setTaiexError] = useState<string | null>(null)

    // ✅ 新增：出入金紀錄（供報酬率模式以 TWR 排除現金流影響）
    // amount 約定：入金 = 正值（資金流入帳戶），出金 = 負值（資金流出帳戶）
    const [cashflows, setCashflows] = useState<{ date: string; amount: number }[]>([])

    // ── 載入快照 ──────────────────────────────────────────────────────────

    const loadSnapshots = async () => {
        const request = ++snapshotRequest.current
        const session = captureUserSession()
        setLoading(true)
        try {
            const [storedSnapshots, trades, dividends, cashRecords] = await Promise.all([
                fetchAssetSnapshots<SnapshotRecord>('asc'),
                fetchTrades<TradeRecord>('asc'),
                fetchDividends<DividendRecord>('asc'),
                fetchCashflow<{ date: string; type: 'in' | 'out'; amount: number }>('asc'),
            ])
            session.assertActive()
            if (request !== snapshotRequest.current) return
            setSnapshots(reconcileSnapshotBreakdowns(storedSnapshots, trades, dividends, cashRecords))
            setCashflows(cashRecords.map(c => ({ date: c.date, amount: c.type === 'in' ? c.amount : -c.amount })))
            setHasLoaded(true)
        } catch (error) {
            if (request !== snapshotRequest.current) return
            // Preserve the last successful values while showing the read error.
            setFormError(error instanceof Error ? error.message : '快照與出入金讀取失敗，請重新整理')
        } finally {
            if (request === snapshotRequest.current) setLoading(false)
        }
    }
    useEffect(() => {
        const requests = snapshotRequest
        void loadSnapshots()
        return () => { requests.current++ }
    }, [syncVersion])

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
            const today = toLocalDateString()
            const raw = await getHistoricalCandles('IX0001', fromDate, today)
            if (!raw.data || raw.data.length === 0) throw new Error('回傳資料為空')

            const map: Record<string, number> = {}
            for (const candle of raw.data) {
                if (candle.date && candle.close != null) {
                    map[candle.date] = candle.close
                }
            }
            setTaiexData(map)
        } catch (reason: unknown) {
            console.error('[IX0001] fetch failed:', reason)
            const message = reason instanceof Error ? reason.message : String(reason)
            setTaiexError(`加權指數載入失敗：${message}`)
        }
        setTaiexLoading(false)
    }

    const handleRefreshTAIEX = (currentSnapshots = snapshots) => {
        // 往第一筆快照日期前推 7 天，確保有對應收盤價
        const earliest = currentSnapshots.length > 0
            ? toLocalDateString(new Date(new Date(currentSnapshots[0].date).getTime() - 7 * 86400000))
            : '2020-01-01'
        fetchTAIEX(earliest)
    }

    // 切換到報酬率模式且 benchmark 開啟時，若尚無資料則自動抓取
    const ensureBenchmark = useEffectEvent(() => {
        if (chartMode === 'return' && showBenchmark && Object.keys(taiexData).length === 0 && !taiexLoading) {
            handleRefreshTAIEX()
        }
    })
    // Trigger only when the user enables this view, not on every loading/error change.
    useEffect(() => { ensureBenchmark() }, [chartMode, showBenchmark])

    // ── 市值計算 ──────────────────────────────────────────────────────────
    // ✅ 5-1：calcMarketValue 抽至 lib/snapshot.ts，手動快照與自動快照共用同一口徑

    // ── 自動帶入（含扣除融資借款）────────────────────────────────────────

    const handleAutoFill = async () => {
        setAutoLoading(true)
        setMissingPriceCodes([])
        try {
            // ✅ 1-1：改走共用快取層（lib/investData）
            const snapshot = await loadPortfolioSnapshot()
            setMissingPriceCodes(snapshot.missingPriceCodes)

            setForm(f => ({
                ...f,
                valuationQuality: 'manual-unverified',
                totalAssets: Math.round(snapshot.netAssets),
                marketValue: Math.round(snapshot.marketValue),
                cash: Math.round(snapshot.cash),
                marginDebt: Math.round(snapshot.marginDebt),
            }))
        } catch (err) { console.error(err) }
        setAutoLoading(false)
    }

    // ── 自動每日快照開關（5-1）───────────────────────────────────────────

    const [autoSnapEnabled, setAutoSnapEnabled] = useState(true)

    useEffect(() => {
        getDoc(userDocNested(investDB, 'settings', 'autoSnapshot'))
            .then(snap => { if (snap.exists()) setAutoSnapEnabled(snap.data().enabled !== false) })
            .catch(err => console.error('[autoSnapshot] 讀取設定失敗:', err))
    }, [])

    const toggleAutoSnap = async () => {
        const next = !autoSnapEnabled
        setAutoSnapEnabled(next)   // 樂觀更新
        try {
            await setDoc(userDocNested(investDB, 'settings', 'autoSnapshot'), { enabled: next })
        } catch (err) {
            console.error('[autoSnapshot] 寫入設定失敗:', err)
            setAutoSnapEnabled(!next)   // 失敗回滾
        }
    }

    // ── 儲存今日快照（含扣除融資借款）───────────────────────────────────

    const saveToday = async () => {
        const session = captureUserSession()
        setSaving(true)
        setMissingPriceCodes([])
        try {
            const { snapshot: payload, missing, stale, guard } = await buildTodaySnapshot()
            const blocked = [...new Set([...missing, ...stale])]
            setMissingPriceCodes(blocked)
            if (blocked.length) {
                setFormError('今日快照未儲存：請先更新這些持股的有效現價：' + blocked.join('、'))
                return
            }
            setFormError('')
            const validation = validateSnapshotForWrite(payload)
            if (!validation.valid) throw new Error(validation.errors.join('；'))
            session.assertActive()
            await saveValuationSnapshot(payload, session, true, guard)
            invalidateAssetSnapshots()
            await loadSnapshots()
        } catch (err) {
            console.error(err)
            setFormError(err instanceof Error ? err.message : '今日快照儲存失敗')
        } finally { setSaving(false) }
    }

    const handleSave = async () => {
        const validation = validateSnapshotForWrite(form)
        if (!validation.valid) { setFormError(validation.errors.join('；')); return }
        setFormError('')
        setFormLoading(true)
        // Manual values may describe a different valuation boundary: do not retain an automatic basis.
        const session = captureUserSession()
        const payload = { ...form, auto: false, valuationQuality: 'manual-unverified' as const, valuationAt: new Date().toISOString() }
        delete payload.cashflowBasis
        delete payload.cashflowNetAtCapture
        try {
        session.assertActive()
        await setDoc(session.doc(investDB, 'assetSnapshots', form.date), payload)
        invalidateAssetSnapshots()
        setShowForm(false); setEditingDate(null); setForm(emptySnap)
        setMissingPriceCodes([])
        await loadSnapshots()
        } catch (error) { setFormError(error instanceof Error ? error.message : '快照儲存失敗') }
        finally { setFormLoading(false) }
    }

    const handleEdit = (s: SnapshotRecord) => { setForm({ ...s }); setEditingDate(s.date); setShowForm(true); setFormError('') }
    const handleDelete = async (date: string) => {
        if (!await confirmAction(`確定要刪除 ${date} 的紀錄？`)) return
        await deleteDoc(userDoc(investDB, 'assetSnapshots', date)); invalidateAssetSnapshots(); loadSnapshots()
    }
    const handleCancel = () => { setShowForm(false); setEditingDate(null); setForm(emptySnap); setMissingPriceCodes([]); setFormError('') }

    // ── 時間範圍篩選 ──────────────────────────────────────────────────────

    const filterByRange = (data: SnapshotRecord[]) => {
        if (range === 'ALL') return data
        const now = new Date()
        const months = range === '1M' ? 1 : range === '3M' ? 3 : range === '6M' ? 6 : 12
        const cutoff = toLocalDateString(new Date(now.getFullYear(), now.getMonth() - months, now.getDate()))
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

    const originalReturnPoints = useMemo(() => buildTimeWeightedReturns(filtered, cashflows, true, true), [filtered, cashflows])
    const restartCandidate = useMemo(() => buildRestartedTimeWeightedReturns(filtered, cashflows, true), [filtered, cashflows])
    const activeReturnPoints = restartIncomplete ? restartCandidate.points : originalReturnPoints
    const originalReturnIssue = originalReturnPoints.find(point => point.issue)

    // Snapshot TWR approximation: zero factors are preserved; undefined segments
    // break the asset line while the independently computed benchmark remains visible.
    const returnChartData = useMemo(() => {
        if (activeReturnPoints.length < 2) return []

        const sortedDates = Object.keys(taiexData).sort()
        const getClosestTAIEX = (date: string): number | null => {
            const before = sortedDates.filter(d => d <= date)
            if (!before.length) return null
            return taiexData[before[before.length - 1]]
        }

        const points = activeReturnPoints
        const baseTAIEX = getClosestTAIEX(points[0].date)

        return points.map(d => {
            const taiexClose = getClosestTAIEX(d.date)
            return {
                date: d.date,
                assetReturn: d.assetReturn,
                issue: d.issue,
                // TAIEX 獨立計算，只要有對應收盤就畫得出來，不受資產線影響
                taiexReturn: baseTAIEX != null && baseTAIEX > 0 && Number.isFinite(baseTAIEX) && taiexClose != null && taiexClose > 0 && Number.isFinite(taiexClose)
                    ? parseFloat(((taiexClose - baseTAIEX) / baseTAIEX * 100).toFixed(2))
                    : null,
            }
        })
    }, [activeReturnPoints, taiexData])

    const returnIssue = returnChartData.find(point => point.issue)

    // ── 超額報酬（最後一筆）──────────────────────────────────────────────

    const excessReturn = useMemo(() => {
        if (!returnChartData.length) return null
        const last = returnChartData[returnChartData.length - 1]
        if (last.taiexReturn == null) return null
        return calculateReturnGap(last.assetReturn, last.taiexReturn)
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
                    <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
                        {/* ✅ 5-1：自動每日快照開關 */}
                        <div style={{ display: 'flex', alignItems: 'center' }}>
                            <button
                                onClick={toggleAutoSnap}
                                style={autoSnapEnabled
                                    ? btn('var(--c-accent)')
                                    : { ...btn('var(--c-card)'), border: '1px solid var(--c-border)', color: 'var(--c-muted)' }}
                            >
                                <Zap size={15} />
                                自動快照：{autoSnapEnabled ? '開' : '關'}
                            </button>
                        </div>
                        <button onClick={saveToday} disabled={saving} style={btn('var(--c-positive)')}>
                            <Save size={15} style={{ animation: saving ? 'spin 1s linear infinite' : 'none' }} />
                            {saving ? '儲存中...' : '儲存今日快照'}
                        </button>
                        <button onClick={() => { setShowForm(true); setEditingDate(null); setForm(emptySnap) }} style={btn('var(--c-accent)')}>
                            <Plus size={15} />手動新增
                        </button>
                    </div>
                </div>

                {!showForm && formError && <div role="alert" style={{ color: 'var(--c-danger)', marginBottom: '16px' }}>{formError}</div>}

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
                        <div style={{ display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' }}>
                            {(['1M', '3M', '6M', '1Y', 'ALL'] as const).map(r => (
                                <button
                                    key={r}
                                    onClick={() => { setRange(r); setRestartIncomplete(false) }}
                                    style={{
                                        backgroundColor: range === r ? 'var(--c-button-accent)' : 'var(--c-card)',
                                        border: '1px solid', borderColor: range === r ? 'var(--c-button-accent)' : 'var(--c-border)',
                                        borderRadius: '6px', padding: '4px 12px',
                                        color: range === r ? 'var(--c-on-accent)' : 'var(--c-muted)',
                                        fontSize: '13px', cursor: 'pointer'
                                    }}
                                >
                                    {r}
                                </button>
                            ))}
                            {chartMode === 'return' && (originalReturnIssue || restartIncomplete) && (
                                <button
                                    type="button"
                                    aria-label={restartIncomplete ? '恢復原區間起點' : '從資料完整日期重新起算'}
                                    aria-pressed={restartIncomplete}
                                    title={restartIncomplete ? '恢復原區間起點' : restartCandidate.startDate ? `從 ${restartCandidate.startDate} 重新起算` : restartCandidate.unavailableReason ?? undefined}
                                    disabled={!restartIncomplete && !restartCandidate.startDate}
                                    onClick={() => setRestartIncomplete(current => !current)}
                                    style={{
                                        backgroundColor: restartIncomplete ? 'color-mix(in srgb, var(--c-accent) 12%, transparent)' : 'transparent',
                                        border: '1px solid', borderColor: restartIncomplete ? 'var(--c-accent)' : 'var(--c-border)',
                                        borderRadius: '6px', padding: '4px 8px', fontSize: '11px', whiteSpace: 'nowrap',
                                        color: restartIncomplete ? 'var(--c-accent)' : 'var(--c-muted)',
                                        cursor: !restartIncomplete && !restartCandidate.startDate ? 'not-allowed' : 'pointer',
                                        opacity: !restartIncomplete && !restartCandidate.startDate ? 0.5 : 1,
                                    }}
                                >
                                    {restartIncomplete ? '恢復起點' : '重新起算'}
                                </button>
                            )}
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
                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '12px', fontSize: '13px', color: 'var(--c-muted)', flexWrap: 'wrap' }}>
                            <span>同期超額報酬：</span>
                            <span style={{ fontWeight: 700, color: excessReturn >= 0 ? 'var(--c-positive)' : 'var(--c-danger)' }}>
                                {excessReturn >= 0 ? '+' : ''}{excessReturn}%
                            </span>
                            <span style={{ fontSize: '11px', color: 'var(--c-muted)' }}>（以 {activeReturnPoints[0]?.date} 為共同起點・近似 TWR）</span>
                        </div>
                    )}

                    {chartMode === 'return' && returnIssue && <div role="status" style={{ color: 'var(--c-warning)', fontSize: '13px', marginBottom: '12px' }}>
                        {returnIssue.date} 起：{returnIssue.issue}。此後資產報酬不顯示，金額與加權指數仍可查看。
                    </div>}
                    {/* 圖表本體 */}
                    {loading && hasLoaded && <p className="ui-refresh-status" role="status">資料更新中…</p>}
                {loading && !hasLoaded ? (
                        <LoadingState />
                    ) : filtered.length < 2 || (chartMode === 'return' && activeReturnPoints.length < 2) ? (
                        <div style={{ textAlign: 'center', padding: '48px', color: 'var(--c-muted)' }}>
                            <p style={{ fontSize: '15px' }}>資料不足，無法顯示趨勢圖</p>
                            <p style={{ fontSize: '13px', marginTop: '8px' }}>請累積至少 2 筆資料</p>
                        </div>
                    ) : chartMode === 'absolute' ? (

                        // ── 金額模式：只顯示總資產（淨值）── 此模式如實呈現帳戶餘額，不受出入金影響邏輯，照舊
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

                        // ── 報酬率對比模式：我的資產(TWR) vs 加權指數 ──
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
                                    name="我的資產（近似 TWR）"
                                    stroke="var(--c-accent)"
                                    strokeWidth={2.5}
                                    dot={false}
                                    activeDot={{ r: 5, fill: 'var(--c-accent)' }}
                                    connectNulls={false}
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

                        {missingPriceCodes.length > 0 && (
                            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', backgroundColor: 'rgba(245,166,35,0.1)', border: '1px solid rgba(245,166,35,0.3)', borderRadius: '8px', padding: '10px 14px', marginBottom: '16px', fontSize: '12px', color: 'var(--c-warning)' }}>
                                <AlertTriangle size={14} style={{ flexShrink: 0 }} />
                                無現價：{missingPriceCodes.join('、')} — 市值以成本替代，數字可能低估
                            </div>
                        )}

                        <div className="snap-form-grid">
                            <div>
                                <label style={lbl}>日期</label>
                                <input type="date" style={inp} value={form.date} onChange={e => setForm(f => ({ ...f, valuationQuality: 'manual-unverified', date: e.target.value }))} />
                            </div>
                            <div>
                                <label style={lbl}>總淨值（已扣融資）</label>
                                <input type="number" style={inp} placeholder="0" value={form.totalAssets || ''} onChange={e => setForm(f => ({ ...f, valuationQuality: 'manual-unverified', totalAssets: parseFloat(e.target.value) || 0 }))} />
                            </div>
                            <div>
                                <label style={lbl}>股票市值</label>
                                <input type="number" style={inp} placeholder="0" value={form.marketValue || ''} onChange={e => setForm(f => ({ ...f, valuationQuality: 'manual-unverified', marketValue: parseFloat(e.target.value) || 0 }))} />
                            </div>
                            <div>
                                <label style={lbl}>現金</label>
                                <input type="number" style={inp} placeholder="0" value={form.cash || ''} onChange={e => setForm(f => ({ ...f, valuationQuality: 'manual-unverified', cash: parseFloat(e.target.value) || 0 }))} />
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
                                            valuationQuality: 'manual-unverified', marginDebt: debt,
                                            totalAssets: Math.round(f.marketValue + f.cash - debt),
                                        }))
                                    }}
                                />
                            </div>
                        </div>
                        {formError && <div style={{ color: 'var(--c-danger)', fontSize: '12px', marginTop: '10px' }}>無法儲存：{formError}</div>}
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
                                            <td style={{ padding: '10px 12px', color: '#c8d0e0' }}>
                                                {s.date}
                                                {s.auto && (
                                                    <span style={{ marginLeft: '6px', fontSize: '10px', backgroundColor: 'color-mix(in srgb, var(--c-accent) 15%, transparent)', color: 'var(--c-accent)', padding: '1px 6px', borderRadius: '10px', verticalAlign: 'middle' }}>自動</span>
                                                )}
                                            </td>
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
