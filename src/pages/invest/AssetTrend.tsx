import { useState, useEffect, useMemo } from 'react'
import { setDoc, deleteDoc, getDoc } from 'firebase/firestore'
import { investDB } from '../../lib/firebase'
import { userDoc, userDocNested } from '../../lib/userDB'
import { fetchCashflow, fetchAssetSnapshots, fetchDividends, fetchTrades, invalidateAssetSnapshots } from '../../lib/investData'
import { loadPortfolioSnapshot } from '../../lib/portfolioSnapshot'
import { reconcileSnapshotBreakdowns, type DividendRecord, type TradeRecord } from '../../lib/calc'
import { toLocalDateString } from '../../lib/date'
import InfoHint from '../../components/InfoHint'
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend, ReferenceLine } from 'recharts'
import { Save, Pencil, Trash2, Plus, X, Check, Zap, AlertTriangle, TrendingUp } from 'lucide-react'
import { useInvestSync } from '../../InvestSyncContext'
import { validateSnapshotForWrite } from '../../lib/investmentValidation'

// ── 型別 ──────────────────────────────────────────────────────────────────

interface SnapshotRecord {
    date: string
    totalAssets: number
    marketValue: number
    cash: number
    marginDebt?: number  // 融資借款（負債），記錄用，總資產已扣除
    auto?: boolean       // ✅ 5-1：由自動快照寫入時為 true
}

const emptySnap: SnapshotRecord = {
    date: toLocalDateString(),
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

// ── 主元件 ────────────────────────────────────────────────────────────────

export default function AssetTrend() {
    const { version: syncVersion } = useInvestSync()
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
    const [formError, setFormError] = useState('')

    // ── Benchmark 相關 state ──────────────────────────────────────────────
    // chartMode: 'absolute' = 金額模式；'return' = 報酬率對比模式
    const [chartMode, setChartMode] = useState<'absolute' | 'return'>('absolute')
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
        setLoading(true)
        const [storedSnapshots, trades, dividends, cashRecords] = await Promise.all([
            fetchAssetSnapshots<SnapshotRecord>('asc'),
            fetchTrades<TradeRecord>('asc'),
            fetchDividends<DividendRecord>('asc'),
            fetchCashflow<{ date: string; type: 'in' | 'out'; amount: number }>('asc'),
        ])
        setSnapshots(reconcileSnapshotBreakdowns(storedSnapshots, trades, dividends, cashRecords))
        setLoading(false)
    }

    useEffect(() => { void loadSnapshots() }, [syncVersion])

    // ✅ 新增：載入出入金紀錄（只需一次）
    //
    // ┌─────────────────────────────────────────────────────────────────┐
    // │ 正負號約定（本檔 = TWR 口徑，入金記「正」）                          │
    // │   入金 'in'  → amount 為正（資金流入帳戶）                          │
    // │   出金 'out' → amount 為負                                         │
    // │ 用途：TWR 段報酬 (本期末淨值 − 本期淨流入) / 上期末淨值，            │
    // │       把「正的入金」扣掉，剩下才是投資操作造成的漲跌。               │
    // │ ⚠️ 注意：YearReview.tsx 的 XIRR 口徑正負號「相反」(入金記負)，       │
    // │   那是 XIRR 期初流出需為負的緣故，兩邊各自正確，請勿改成一致。       │
    // └─────────────────────────────────────────────────────────────────┘
    useEffect(() => {
        // ✅ 1-1：改走共用快取層（lib/investData）
        fetchCashflow<{ date: string; type: 'in' | 'out'; amount: number }>('asc')
            .then(records => {
                // 入金為帳戶資金流入(正)，出金為流出(負)
                setCashflows(records.map(c => ({ date: c.date, amount: c.type === 'in' ? c.amount : -c.amount })))
            })
            .catch(err => console.error('[cashflow] load failed:', err))
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
            ? toLocalDateString(new Date(new Date(currentSnapshots[0].date).getTime() - 7 * 86400000))
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
        setSaving(true)
        setMissingPriceCodes([])
        try {
            // ✅ 1-1：改走共用快取層（lib/investData）
            const snapshot = await loadPortfolioSnapshot()
            setMissingPriceCodes(snapshot.missingPriceCodes)
            const today = toLocalDateString()
            const payload = {
                date: today,
                totalAssets: Math.round(snapshot.netAssets),
                marketValue: Math.round(snapshot.marketValue),
                cash: Math.round(snapshot.cash),
                marginDebt: Math.round(snapshot.marginDebt),
                dividendAdjusted: true,  // 新口徑快照（cash 已含股利），遷移時略過
            }
            const validation = validateSnapshotForWrite(payload)
            if (!validation.valid) throw new Error(validation.errors.join('；'))
            await setDoc(userDoc(investDB, 'assetSnapshots', today), payload)
            invalidateAssetSnapshots()
            await loadSnapshots()
        } catch (err) { console.error(err) }
        setSaving(false)
    }

    const handleSave = async () => {
        const validation = validateSnapshotForWrite(form)
        if (!validation.valid) { setFormError(validation.errors.join('；')); return }
        setFormError('')
        setFormLoading(true)
        await setDoc(userDoc(investDB, 'assetSnapshots', form.date), { ...form })
        invalidateAssetSnapshots()
        setShowForm(false); setEditingDate(null); setForm(emptySnap)
        setMissingPriceCodes([])
        setFormLoading(false); loadSnapshots()
    }

    const handleEdit = (s: SnapshotRecord) => { setForm({ ...s }); setEditingDate(s.date); setShowForm(true); setFormError('') }
    const handleDelete = async (date: string) => {
        if (!confirm(`確定要刪除 ${date} 的紀錄？`)) return
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

    // ── 報酬率對比資料（報酬率模式）──────────────────────────────────────
    //
    // ✅ 修正：資產報酬用 TWR（時間加權報酬率），排除出入金影響。
    //   重點防呆（解決「有出入金時 TAIEX 不顯示」的問題）：
    //   1. 段報酬一旦算出非正數或非有限值，該段以 1（= 0% 變動）帶過，
    //      避免 twrIndex 被污染成負數 / NaN，連帶讓整張圖 Y 軸崩潰、TAIEX 消失。
    //   2. assetReturn 永遠輸出有限數值（保底 0），不會是 NaN。
    //   3. 出入金正負號不再依賴外部約定：以「入金 = 流入帳戶（正值）」為準，
    //      段報酬把它扣掉 → (本期末淨值 − 本期淨流入) / 上期末淨值。
    //
    //   TAIEX 與資產線各自獨立計算，互不影響；TAIEX 只要有對應收盤就一定畫得出來。

    const returnChartData = useMemo(() => {
        if (filtered.length < 2) return []

        const sortedDates = Object.keys(taiexData).sort()
        const getClosestTAIEX = (date: string): number | null => {
            const before = sortedDates.filter(d => d <= date)
            if (!before.length) return null
            return taiexData[before[before.length - 1]]
        }

        const baseTAIEX = getClosestTAIEX(filtered[0].date)

        // TWR 累積報酬指數：起點 1（= 0%）
        let twrIndex = 1
        let prevAsset = filtered[0].totalAssets

        return filtered.map((d, i) => {
            if (i > 0) {
                // (前一快照日, 當前快照日] 區間內的淨流入（入金為正、出金為負）
                // 不論 cashflows 來源正負號如何，這裡統一視「入金 = 正」處理
                const flowInPeriod = cashflows
                    .filter(cf => cf.date > filtered[i - 1].date && cf.date <= d.date)
                    .reduce((s, cf) => s + cf.amount, 0)

                // 段報酬 = (本期末淨值 − 本期淨流入) / 上期末淨值
                const denom = prevAsset
                const numer = d.totalAssets - flowInPeriod
                const segReturn = denom > 0 ? numer / denom : 1

                // ✅ 防呆：段報酬必須是有限正數，否則以 1 帶過（視為當天無變動）
                //   這避免入金日造成的極端值 / 負值 / NaN 把整條線打爆。
                if (Number.isFinite(segReturn) && segReturn > 0) {
                    twrIndex *= segReturn
                }
                prevAsset = d.totalAssets
            }

            const taiexClose = getClosestTAIEX(d.date)
            // ✅ assetReturn 保底為有限數，永遠不會是 NaN
            const assetReturn = Number.isFinite(twrIndex)
                ? parseFloat(((twrIndex - 1) * 100).toFixed(2))
                : 0

            return {
                date: d.date,
                assetReturn,
                // TAIEX 獨立計算，只要有對應收盤就畫得出來，不受資產線影響
                taiexReturn: baseTAIEX != null && taiexClose != null
                    ? parseFloat(((taiexClose - baseTAIEX) / baseTAIEX * 100).toFixed(2))
                    : null,
            }
        })
    }, [filtered, taiexData, cashflows])

    // ── 超額報酬（最後一筆）──────────────────────────────────────────────

    const excessReturn = useMemo(() => {
        if (!returnChartData.length) return null
        const last = returnChartData[returnChartData.length - 1]
        if (last.taiexReturn == null) return null
        return parseFloat((last.assetReturn - last.taiexReturn).toFixed(2))
    }, [returnChartData])

    // ✅ 區間內是否有出入金（用於提示文案）
    const hasCashflowInRange = useMemo(() => {
        if (filtered.length < 2) return false
        const start = filtered[0].date
        const end = filtered[filtered.length - 1].date
        return cashflows.some(cf => cf.date > start && cf.date <= end)
    }, [filtered, cashflows])

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
                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '12px', fontSize: '13px', color: 'var(--c-muted)', flexWrap: 'wrap' }}>
                            <span>同期超額報酬：</span>
                            <span style={{ fontWeight: 700, color: excessReturn >= 0 ? 'var(--c-positive)' : 'var(--c-danger)' }}>
                                {excessReturn >= 0 ? '+' : ''}{excessReturn}%
                            </span>
                            <span style={{ fontSize: '11px', color: '#4a5568' }}>（以首筆快照 {filtered[0]?.date} 為基準・TWR 時間加權）</span>
                        </div>
                    )}

                    {/* ✅ 區間內有出入金時的提示：說明報酬率已用 TWR 排除 */}
                    {chartMode === 'return' && hasCashflowInRange && (
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', backgroundColor: 'color-mix(in srgb, var(--c-accent) 8%, transparent)', border: '1px solid color-mix(in srgb, var(--c-accent) 30%, transparent)', borderRadius: '8px', padding: '8px 14px', marginBottom: '12px', fontSize: '12px', color: 'var(--c-accent)' }}>
                            <TrendingUp size={13} style={{ flexShrink: 0 }} />
                            此區間有出入金，報酬率已採 TWR（時間加權）排除出入金影響，僅反映投資操作績效。
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
                                    name="我的資產（TWR）"
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
                            資料來源：Fugle MarketData｜資產線採 TWR 時間加權（排除出入金），以首筆快照為基準點（0%）正規化對比
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
