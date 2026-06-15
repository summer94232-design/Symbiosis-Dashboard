/**
 * SoldTracker.tsx — 賣出追蹤 v2.1
 *
 * v2 功能：
 * 1. 可設定決策判斷閾值（預設 ±3%，neutral 區間說明清楚）
 * 2. 追蹤期間新增 7 日、14 日選項
 * 3. 通知面板：偵測 14 日內賣出的股票現價超過設定閾值（預設 +10%）即顯示警示
 *
 * v2.1 修正（優化建議書 1-1 / 1-3 補套用）：
 * - load() 改走 investData 共用快取（fetchTrades），不再各自 getDocs 全量讀取
 * - refreshPrices() 改走 PriceContext.updatePrices：報價寫回 settings/lastPrices、
 *   跨頁同步、不重複扣 Fugle 額度；同時會觸發自動快照（見 snapshot.ts）
 * - 通知設定載入改為逐欄位驗證型別後建構，避免 spread Record<string, unknown>
 *   造成的型別不安全
 * - 修正通知設定面板 bug：開啟設定時同步 draft 與最新 config（原本 draft 只在
 *   mount 時初始化，Firestore 設定載回來後開面板會看到預設值，按套用會把
 *   已儲存設定蓋回預設）
 */

import { useState, useEffect, useCallback } from 'react'
import { getDoc, setDoc } from 'firebase/firestore'
import { investDB } from '../../lib/firebase'
import { userDocNested } from '../../lib/userDB'
import { getHistoricalCandles } from '../../lib/fugle'
import { fetchTrades } from '../../lib/investData'
import { usePrices } from '../../PriceContext'
import {
    RefreshCw, TrendingDown, ChevronDown, ChevronRight,
    BarChart2, Bell, Settings2, X, AlertTriangle, Info
} from 'lucide-react'

// ── Types ──────────────────────────────────────────────────────────────────

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
}

interface SoldRecord {
    id: string
    date: string
    code: string
    name: string
    soldPrice: number
    shares: number
    soldNet: number
    note: string
    currentPrice: number | null
    daysSinceSold: number
}

interface CandleBar {
    date: string
    open: number
    high: number
    low: number
    close: number
    volume: number
}

interface AlertConfig {
    /** 通知觀察天數：賣出後幾日內才觸發通知 */
    watchDays: number
    /** 漲幅觸發閾值（%） */
    riseThreshold: number
    /** 跌幅觸發閾值（%，0 = 不偵測） */
    dropThreshold: number
}

interface AlertItem {
    record: SoldRecord
    changePct: number
    type: 'rise' | 'drop'
}

// ── 樣式常數 ───────────────────────────────────────────────────────────────

const card: React.CSSProperties = {
    backgroundColor: 'var(--c-card)',
    border: '1px solid var(--c-border)',
    borderRadius: '12px',
    padding: '20px',
}

const btn = (color: string, extra?: React.CSSProperties): React.CSSProperties => ({
    backgroundColor: color,
    border: 'none',
    borderRadius: '8px',
    padding: '8px 16px',
    color: '#fff',
    fontSize: '13px',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    ...extra,
})

const numInp: React.CSSProperties = {
    backgroundColor: 'var(--c-bg)',
    border: '1px solid var(--c-border)',
    borderRadius: '6px',
    padding: '4px 8px',
    color: 'var(--c-text)',
    fontSize: '13px',
    width: '64px',
    outline: 'none',
    textAlign: 'right',
}

// ── 決策判斷邏輯 ────────────────────────────────────────────────────────────
//
//  賣後漲幅 > +threshold%  → 賣早了（✗ bad）   — 漲超過門檻，代表提早離場錯過獲利
//  賣後漲幅 < -threshold%  → 賣對了（✓ good）  — 跌超過門檻，代表賣出時機正確
//  介於 ±threshold% 之間   → 差不多（— neutral）— 漲跌幅在門檻內，決策沒有明顯對錯

function calcVerdict(
    changePct: number | null,
    threshold: number
): 'good' | 'bad' | 'neutral' | 'pending' {
    if (changePct == null) return 'pending'
    if (changePct > threshold) return 'bad'
    if (changePct < -threshold) return 'good'
    return 'neutral'
}

const VERDICT_BADGE = {
    good: { label: '✓ 賣對了', bg: 'color-mix(in srgb, var(--c-positive) 15%, transparent)', color: 'var(--c-positive)' },
    bad: { label: '✗ 賣早了', bg: 'color-mix(in srgb, var(--c-danger) 15%, transparent)', color: 'var(--c-danger)' },
    neutral: { label: '— 差不多', bg: 'color-mix(in srgb, var(--c-warning) 15%, transparent)', color: 'var(--c-warning)' },
    pending: { label: '待取得報價', bg: 'color-mix(in srgb, var(--c-muted) 15%, transparent)', color: 'var(--c-muted)' },
}

// ── 輔助函式 ───────────────────────────────────────────────────────────────

function daysSince(dateStr: string): number {
    return Math.floor((Date.now() - new Date(dateStr).getTime()) / 86400000)
}
function fmtPct(v: number): string {
    return (v >= 0 ? '+' : '') + v.toFixed(2) + '%'
}
function fmtMoney(v: number): string {
    return (v >= 0 ? '+' : '') + Math.round(v).toLocaleString()
}
function pctColor(v: number): string {
    if (v > 0) return 'var(--c-danger)'
    if (v < 0) return 'var(--c-positive)'
    return 'var(--c-muted)'
}

// ── 迷你 K 線圖 ────────────────────────────────────────────────────────────

function MiniCandleChart({ candles, soldPrice }: { candles: CandleBar[]; soldPrice: number }) {
    if (candles.length === 0) return (
        <div style={{ height: '160px', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--c-muted)', fontSize: '13px' }}>
            無法取得 K 線資料
        </div>
    )
    const W = 560, H = 160, PAD = 32
    const prices = candles.flatMap(c => [c.high, c.low])
    prices.push(soldPrice)
    const minP = Math.min(...prices), maxP = Math.max(...prices)
    const range = maxP - minP || 1
    const barW = Math.max(2, Math.floor((W - PAD * 2) / candles.length) - 1)
    const toY = (p: number) => PAD + ((maxP - p) / range) * (H - PAD * 2)
    const toX = (i: number) => PAD + i * ((W - PAD * 2) / (candles.length - 1 || 1))
    const linePoints = candles.map((c, i) => `${toX(i)},${toY(c.close)}`).join(' ')
    const soldY = toY(soldPrice)

    return (
        <div style={{ overflowX: 'auto' }}>
            <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', maxWidth: W, minWidth: 280, height: H }}>
                {[0, 0.25, 0.5, 0.75, 1].map(f => {
                    const y = PAD + f * (H - PAD * 2)
                    const p = maxP - f * range
                    return (
                        <g key={f}>
                            <line x1={PAD} y1={y} x2={W - PAD} y2={y} stroke="var(--c-border)" strokeWidth={0.5} />
                            <text x={PAD - 4} y={y + 4} fontSize={9} fill="var(--c-muted)" textAnchor="end">{p.toFixed(1)}</text>
                        </g>
                    )
                })}
                {candles.map((c, i) => {
                    const x = toX(i)
                    const isUp = c.close >= c.open
                    const color = isUp ? 'var(--c-danger)' : 'var(--c-positive)'
                    const bodyTop = toY(Math.max(c.open, c.close))
                    const bodyBot = toY(Math.min(c.open, c.close))
                    const bodyH = Math.max(1, bodyBot - bodyTop)
                    return (
                        <g key={i}>
                            <line x1={x} y1={toY(c.high)} x2={x} y2={toY(c.low)} stroke={color} strokeWidth={1} />
                            <rect x={x - barW / 2} y={bodyTop} width={barW} height={bodyH} fill={color} />
                        </g>
                    )
                })}
                <polyline points={linePoints} fill="none" stroke="var(--c-accent)" strokeWidth={1.2} opacity={0.5} />
                <line x1={PAD} y1={soldY} x2={W - PAD} y2={soldY} stroke="var(--c-warning)" strokeWidth={1} strokeDasharray="4,3" />
                <text x={W - PAD + 4} y={soldY + 4} fontSize={9} fill="var(--c-warning)">賣出 {soldPrice}</text>
                {candles.map((c, i) => {
                    const step = Math.max(1, Math.floor(candles.length / 5))
                    if (i % step !== 0 && i !== candles.length - 1) return null
                    return (
                        <text key={i} x={toX(i)} y={H - 4} fontSize={9} fill="var(--c-muted)" textAnchor="middle">
                            {c.date.slice(5)}
                        </text>
                    )
                })}
            </svg>
        </div>
    )
}

// ── 通知面板 ────────────────────────────────────────────────────────────────

function AlertPanel({
    alerts, config, onConfigChange, onDismiss,
}: {
    alerts: AlertItem[]
    config: AlertConfig
    onConfigChange: (c: AlertConfig) => void
    onDismiss: (code: string, date: string) => void
}) {
    const [showSettings, setShowSettings] = useState(false)
    const [draft, setDraft] = useState(config)

    const hasAlerts = alerts.length > 0
    const saveSettings = () => { onConfigChange(draft); setShowSettings(false) }

    // ✅ v2.1 修正：開啟設定面板時以最新 config 重置 draft。
    // 原本 draft 只在 mount 初始化，Firestore 設定非同步載回後 config 已更新
    // 但 draft 還是預設值，直接按「套用」會把已儲存的設定蓋回預設。
    const toggleSettings = () => {
        setShowSettings(v => {
            if (!v) setDraft(config)
            return !v
        })
    }

    return (
        <div style={{
            border: `1px solid ${hasAlerts ? 'color-mix(in srgb, var(--c-danger) 40%, transparent)' : 'var(--c-border)'}`,
            borderRadius: '12px', overflow: 'hidden', marginBottom: '20px',
            backgroundColor: hasAlerts ? 'color-mix(in srgb, var(--c-danger) 5%, transparent)' : 'var(--c-card)',
        }}>
            {/* 標題列 */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px', borderBottom: showSettings || hasAlerts ? `1px solid ${hasAlerts ? 'color-mix(in srgb, var(--c-danger) 20%, transparent)' : 'var(--c-border)'}` : 'none' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontWeight: 600, fontSize: '14px', color: hasAlerts ? 'var(--c-danger)' : 'var(--c-muted)' }}>
                    <Bell size={15} />
                    {hasAlerts
                        ? <><span style={{ color: 'var(--c-danger)', fontWeight: 700 }}>波動通知</span><span style={{ fontSize: '13px' }}>（{alerts.length} 筆觸發）</span></>
                        : <span>波動通知</span>
                    }
                    <span style={{ fontSize: '11px', fontWeight: 400, color: 'var(--c-muted)' }}>
                        · {config.watchDays} 天內賣出，漲超 {config.riseThreshold}%
                        {config.dropThreshold > 0 ? ` / 跌超 ${config.dropThreshold}%` : ''}
                        {!hasAlerts && ' — 目前無觸發'}
                    </span>
                </div>
                <button onClick={toggleSettings}
                    style={{ background: 'none', border: '1px solid var(--c-border)', borderRadius: '6px', cursor: 'pointer', color: 'var(--c-muted)', display: 'flex', gap: '4px', alignItems: 'center', fontSize: '12px', padding: '4px 10px' }}>
                    <Settings2 size={13} /> 設定
                </button>
            </div>

            {/* 通知設定面板 */}
            {showSettings && (
                <div style={{ padding: '14px 16px', borderBottom: '1px solid color-mix(in srgb, var(--c-danger) 20%, transparent)', backgroundColor: 'var(--c-card)' }}>
                    <div style={{ display: 'flex', gap: '20px', flexWrap: 'wrap', alignItems: 'flex-end' }}>
                        <div>
                            <div style={{ fontSize: '11px', color: 'var(--c-muted)', marginBottom: '4px' }}>觀察天數（賣出後幾日內）</div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                                <input type="number" min={1} max={90} value={draft.watchDays}
                                    onChange={e => setDraft(d => ({ ...d, watchDays: Number(e.target.value) }))}
                                    style={numInp} />
                                <span style={{ fontSize: '12px', color: 'var(--c-muted)' }}>天</span>
                            </div>
                        </div>
                        <div>
                            <div style={{ fontSize: '11px', color: 'var(--c-muted)', marginBottom: '4px' }}>漲幅警示閾值</div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                                <span style={{ fontSize: '12px', color: 'var(--c-muted)' }}>+</span>
                                <input type="number" min={1} max={100} step={0.5} value={draft.riseThreshold}
                                    onChange={e => setDraft(d => ({ ...d, riseThreshold: Number(e.target.value) }))}
                                    style={numInp} />
                                <span style={{ fontSize: '12px', color: 'var(--c-muted)' }}>%</span>
                            </div>
                        </div>
                        <div>
                            <div style={{ fontSize: '11px', color: 'var(--c-muted)', marginBottom: '4px' }}>跌幅警示閾值（0 = 不偵測）</div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                                <span style={{ fontSize: '12px', color: 'var(--c-muted)' }}>-</span>
                                <input type="number" min={0} max={100} step={0.5} value={draft.dropThreshold}
                                    onChange={e => setDraft(d => ({ ...d, dropThreshold: Number(e.target.value) }))}
                                    style={numInp} />
                                <span style={{ fontSize: '12px', color: 'var(--c-muted)' }}>%</span>
                            </div>
                        </div>
                        <div style={{ display: 'flex', gap: '8px' }}>
                            <button onClick={saveSettings} style={btn('var(--c-accent)', { padding: '6px 14px', fontSize: '12px' })}>套用</button>
                            <button onClick={() => setShowSettings(false)}
                                style={{ background: 'transparent', border: '1px solid var(--c-border)', borderRadius: '8px', padding: '6px 10px', fontSize: '12px', color: 'var(--c-muted)', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '4px' }}>
                                取消
                            </button>
                        </div>
                    </div>
                    <div style={{ marginTop: '10px', fontSize: '11px', color: 'var(--c-muted)', display: 'flex', alignItems: 'center', gap: '6px' }}>
                        <Info size={11} />
                        每次點擊「更新現價」後自動重新掃描。手動關閉的通知在下次刷新前不會再出現。
                    </div>
                </div>
            )}

            {/* 通知列表 */}
            <div style={{ padding: '10px 16px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {alerts.map(({ record, changePct, type }) => (
                    <div key={record.id + record.date + type} style={{
                        display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap',
                        backgroundColor: 'var(--c-card)', borderRadius: '8px', padding: '10px 14px',
                        border: `1px solid ${type === 'rise'
                            ? 'color-mix(in srgb, var(--c-danger) 30%, transparent)'
                            : 'color-mix(in srgb, var(--c-positive) 30%, transparent)'}`,
                    }}>
                        <AlertTriangle size={15} color={type === 'rise' ? 'var(--c-danger)' : 'var(--c-positive)'} style={{ flexShrink: 0 }} />
                        <div style={{ fontWeight: 700, color: 'var(--c-accent)', fontSize: '14px', minWidth: '50px' }}>{record.code}</div>
                        <div style={{ fontSize: '12px', color: 'var(--c-muted)' }}>{record.name}</div>
                        <div style={{ fontSize: '12px', color: 'var(--c-muted)' }}>
                            賣出：{record.date}
                            <span style={{ marginLeft: '4px', opacity: 0.7 }}>（{record.daysSinceSold} 天前）</span>
                        </div>
                        <div style={{ display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' }}>
                            <span style={{ fontSize: '12px', color: 'var(--c-muted)' }}>賣出價 {record.soldPrice}</span>
                            <span style={{ fontSize: '12px', color: 'var(--c-muted)' }}>→</span>
                            <span style={{ fontSize: '12px', color: 'var(--c-muted)' }}>現價 {record.currentPrice?.toFixed(2)}</span>
                            <span style={{ fontSize: '14px', fontWeight: 700, color: type === 'rise' ? 'var(--c-danger)' : 'var(--c-positive)' }}>
                                {fmtPct(changePct)}
                            </span>
                        </div>
                        <div style={{ fontSize: '12px', fontWeight: 600, color: type === 'rise' ? 'var(--c-danger)' : 'var(--c-positive)' }}>
                            {type === 'rise'
                                ? `↑ 賣後大漲，機會成本 ${fmtMoney((record.currentPrice! - record.soldPrice) * record.shares)} 元`
                                : `↓ 賣後大跌，決策正確`
                            }
                        </div>
                        <button onClick={() => onDismiss(record.code, record.date)}
                            title="關閉此通知"
                            style={{ marginLeft: 'auto', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--c-muted)', display: 'flex', opacity: 0.5 }}
                            onMouseEnter={e => (e.currentTarget.style.opacity = '1')}
                            onMouseLeave={e => (e.currentTarget.style.opacity = '0.5')}>
                            <X size={14} />
                        </button>
                    </div>
                ))}
            </div>
        </div>
    )
}

// ── 決策閾值說明列 ──────────────────────────────────────────────────────────

function VerdictLegend({ threshold, onChangeThreshold }: {
    threshold: number
    onChangeThreshold: (v: number) => void
}) {
    const [editing, setEditing] = useState(false)
    const [draft, setDraft] = useState(String(threshold))

    const save = () => {
        const v = parseFloat(draft)
        if (!isNaN(v) && v >= 0.5) onChangeThreshold(v)
        setEditing(false)
    }

    return (
        <div style={{ ...card, padding: '12px 16px', marginBottom: '16px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
                {/* 閾值設定 */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: 'var(--c-muted)' }}>
                    <Info size={13} />
                    <span>決策判斷閾值：</span>
                    {editing ? (
                        <>
                            <span style={{ fontSize: '12px', color: 'var(--c-muted)' }}>±</span>
                            <input type="number" min={0.5} max={20} step={0.5}
                                value={draft}
                                onChange={e => setDraft(e.target.value)}
                                onKeyDown={e => e.key === 'Enter' && save()}
                                style={{ ...numInp, width: '52px', fontSize: '12px' }}
                                autoFocus />
                            <span style={{ fontSize: '12px', color: 'var(--c-muted)' }}>%</span>
                            <button onClick={save} style={btn('var(--c-accent)', { padding: '3px 10px', fontSize: '11px' })}>套用</button>
                            <button onClick={() => setEditing(false)}
                                style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--c-muted)', fontSize: '11px' }}>取消</button>
                        </>
                    ) : (
                        <button onClick={() => { setDraft(String(threshold)); setEditing(true) }}
                            style={{ background: 'none', border: '1px solid var(--c-border)', borderRadius: '4px', padding: '2px 8px', fontSize: '12px', color: 'var(--c-accent)', cursor: 'pointer' }}>
                            ±{threshold}%
                        </button>
                    )}
                </div>

                {/* 色塊說明 */}
                <div style={{ display: 'flex', gap: '10px', fontSize: '11px', flexWrap: 'wrap', marginLeft: '8px' }}>
                    <span style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
                        <span style={{ padding: '1px 7px', borderRadius: '4px', backgroundColor: 'color-mix(in srgb, var(--c-positive) 15%, transparent)', color: 'var(--c-positive)', fontWeight: 700, fontSize: '10px' }}>✓ 賣對了</span>
                        <span style={{ color: 'var(--c-muted)' }}>現價跌超 {threshold}%</span>
                    </span>
                    <span style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
                        <span style={{ padding: '1px 7px', borderRadius: '4px', backgroundColor: 'color-mix(in srgb, var(--c-warning) 15%, transparent)', color: 'var(--c-warning)', fontWeight: 700, fontSize: '10px' }}>— 差不多</span>
                        <span style={{ color: 'var(--c-muted)' }}>現價在 ±{threshold}% 之間</span>
                    </span>
                    <span style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
                        <span style={{ padding: '1px 7px', borderRadius: '4px', backgroundColor: 'color-mix(in srgb, var(--c-danger) 15%, transparent)', color: 'var(--c-danger)', fontWeight: 700, fontSize: '10px' }}>✗ 賣早了</span>
                        <span style={{ color: 'var(--c-muted)' }}>現價漲超 {threshold}%</span>
                    </span>
                </div>
            </div>
        </div>
    )
}

// ── 單筆賣出卡片 ────────────────────────────────────────────────────────────

function SoldCard({ record, verdictThreshold }: { record: SoldRecord; verdictThreshold: number }) {
    const [expanded, setExpanded] = useState(false)
    const [candles, setCandles] = useState<CandleBar[] | null>(null)
    const [candleLoading, setCandleLoading] = useState(false)

    const changePct = record.currentPrice != null
        ? ((record.currentPrice - record.soldPrice) / record.soldPrice) * 100
        : null

    const opportunityCost = record.currentPrice != null
        ? (record.currentPrice - record.soldPrice) * record.shares
        : null

    const verdict = calcVerdict(changePct, verdictThreshold)
    const verdictBadge = VERDICT_BADGE[verdict]

    const handleExpand = useCallback(async () => {
        setExpanded(v => !v)
        if (candles !== null) return
        setCandleLoading(true)
        try {
            const today = new Date().toISOString().split('T')[0]
            const raw = await getHistoricalCandles(record.code, record.date, today)
            if (raw?.data && Array.isArray(raw.data)) {
                setCandles(raw.data.map((d: any) => ({
                    date: d.date, open: d.open, high: d.high, low: d.low,
                    close: d.close, volume: d.volume ?? 0,
                })))
            } else {
                setCandles([])
            }
        } catch {
            setCandles([])
        }
        setCandleLoading(false)
    }, [candles, record.code, record.date])

    return (
        <div style={{ ...card, padding: '0', overflow: 'hidden', marginBottom: '10px' }}>
            <div onClick={handleExpand}
                style={{ padding: '14px 18px', display: 'flex', alignItems: 'center', gap: '12px', cursor: 'pointer', flexWrap: 'wrap' }}>
                <span style={{ color: 'var(--c-muted)', flexShrink: 0 }}>
                    {expanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                </span>
                <div style={{ minWidth: '80px' }}>
                    <div style={{ fontSize: '15px', fontWeight: 700, color: 'var(--c-accent)' }}>{record.code}</div>
                    <div style={{ fontSize: '11px', color: 'var(--c-muted)' }}>{record.name}</div>
                </div>
                <div style={{ minWidth: '90px' }}>
                    <div style={{ fontSize: '12px', color: 'var(--c-muted)' }}>賣出日</div>
                    <div style={{ fontSize: '13px', color: 'var(--c-text)' }}>{record.date}</div>
                    <div style={{ fontSize: '10px', color: 'var(--c-muted)' }}>{record.daysSinceSold} 天前</div>
                </div>
                <div style={{ minWidth: '70px' }}>
                    <div style={{ fontSize: '12px', color: 'var(--c-muted)' }}>賣出價</div>
                    <div style={{ fontSize: '14px', fontWeight: 600, color: 'var(--c-text)' }}>{record.soldPrice.toFixed(2)}</div>
                </div>
                <div style={{ minWidth: '70px' }}>
                    <div style={{ fontSize: '12px', color: 'var(--c-muted)' }}>現價</div>
                    <div style={{ fontSize: '14px', fontWeight: 600, color: record.currentPrice != null ? 'var(--c-text)' : 'var(--c-muted)' }}>
                        {record.currentPrice != null ? record.currentPrice.toFixed(2) : '—'}
                    </div>
                </div>
                <div style={{ minWidth: '80px' }}>
                    <div style={{ fontSize: '12px', color: 'var(--c-muted)' }}>賣後漲跌</div>
                    <div style={{ fontSize: '15px', fontWeight: 700, color: changePct != null ? pctColor(changePct) : 'var(--c-muted)' }}>
                        {changePct != null ? fmtPct(changePct) : '—'}
                    </div>
                </div>
                <div style={{ minWidth: '100px' }}>
                    <div style={{ fontSize: '12px', color: 'var(--c-muted)' }}>機會損益</div>
                    <div style={{ fontSize: '14px', fontWeight: 600, color: opportunityCost != null ? (opportunityCost > 0 ? 'var(--c-danger)' : 'var(--c-positive)') : 'var(--c-muted)' }}>
                        {opportunityCost != null ? fmtMoney(opportunityCost) : '—'}
                    </div>
                </div>
                <div style={{ marginLeft: 'auto' }}>
                    <span style={{ fontSize: '11px', fontWeight: 700, padding: '3px 10px', borderRadius: '20px', backgroundColor: verdictBadge.bg, color: verdictBadge.color, whiteSpace: 'nowrap' }}>
                        {verdictBadge.label}
                    </span>
                </div>
            </div>

            {expanded && (
                <div style={{ borderTop: '1px solid var(--c-border)', padding: '16px 18px', backgroundColor: 'var(--c-bg)' }}>
                    <div style={{ display: 'flex', gap: '24px', marginBottom: '14px', flexWrap: 'wrap' }}>
                        {[
                            { label: '賣出股數', value: record.shares.toLocaleString() + ' 股' },
                            { label: '賣出淨收', value: '$' + Math.round(record.soldNet).toLocaleString() },
                            { label: '持有後若現售', value: record.currentPrice != null ? '$' + Math.round(record.currentPrice * record.shares).toLocaleString() : '—' },
                        ].map(({ label, value }) => (
                            <div key={label}>
                                <div style={{ fontSize: '11px', color: 'var(--c-muted)' }}>{label}</div>
                                <div style={{ fontSize: '14px', fontWeight: 600, color: 'var(--c-text)' }}>{value}</div>
                            </div>
                        ))}
                        {record.note && (
                            <div>
                                <div style={{ fontSize: '11px', color: 'var(--c-muted)' }}>備註</div>
                                <div style={{ fontSize: '13px', color: 'var(--c-text)', maxWidth: '240px' }}>{record.note}</div>
                            </div>
                        )}
                    </div>
                    <div style={{ fontSize: '12px', color: 'var(--c-muted)', marginBottom: '8px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                        <BarChart2 size={13} />
                        賣出後走勢（{record.date} 至今）
                        <span style={{ fontSize: '10px', marginLeft: '4px', padding: '1px 6px', borderRadius: '4px', backgroundColor: 'color-mix(in srgb, var(--c-warning) 15%, transparent)', color: 'var(--c-warning)' }}>
                            ── 賣出價
                        </span>
                    </div>
                    {candleLoading ? (
                        <div style={{ height: '160px', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--c-muted)', fontSize: '13px' }}>
                            載入 K 線中...
                        </div>
                    ) : (
                        <MiniCandleChart candles={candles ?? []} soldPrice={record.soldPrice} />
                    )}
                </div>
            )}
        </div>
    )
}

// ── 統計摘要 ────────────────────────────────────────────────────────────────

function SummaryBar({ records, verdictThreshold }: { records: SoldRecord[]; verdictThreshold: number }) {
    const withPrice = records.filter(r => r.currentPrice != null)
    if (withPrice.length === 0) return null

    const changes = withPrice.map(r => ((r.currentPrice! - r.soldPrice) / r.soldPrice) * 100)
    const avgChange = changes.reduce((a, b) => a + b, 0) / changes.length
    const goodCount = withPrice.filter(r => calcVerdict(((r.currentPrice! - r.soldPrice) / r.soldPrice) * 100, verdictThreshold) === 'good').length
    const badCount = withPrice.filter(r => calcVerdict(((r.currentPrice! - r.soldPrice) / r.soldPrice) * 100, verdictThreshold) === 'bad').length
    const totalOC = withPrice.reduce((sum, r) => sum + (r.currentPrice! - r.soldPrice) * r.shares, 0)
    const bestSell = withPrice.reduce((b, r) => ((r.currentPrice! - r.soldPrice) / r.soldPrice) < ((b.currentPrice! - b.soldPrice) / b.soldPrice) ? r : b)
    const worstSell = withPrice.reduce((w, r) => ((r.currentPrice! - r.soldPrice) / r.soldPrice) > ((w.currentPrice! - w.soldPrice) / w.soldPrice) ? r : w)

    const stats = [
        { label: '追蹤筆數', value: `${records.length} 筆`, sub: `已取得報價 ${withPrice.length} 筆` },
        { label: '平均賣後漲跌', value: fmtPct(avgChange), color: pctColor(avgChange), sub: avgChange > 0 ? '整體賣太早' : '整體賣得好' },
        { label: '賣對 / 賣早', value: `${goodCount} / ${badCount}`, sub: `準確率 ${withPrice.length > 0 ? Math.round((goodCount / withPrice.length) * 100) : 0}%` },
        { label: '總機會損益', value: fmtMoney(totalOC), color: totalOC > 0 ? 'var(--c-danger)' : 'var(--c-positive)', sub: totalOC > 0 ? '若持有至今賺更多' : '賣出時機良好' },
        { label: '最佳決策', value: bestSell.code, sub: fmtPct(((bestSell.currentPrice! - bestSell.soldPrice) / bestSell.soldPrice) * 100), subColor: 'var(--c-positive)' },
        { label: '最需反省', value: worstSell.code, sub: fmtPct(((worstSell.currentPrice! - worstSell.soldPrice) / worstSell.soldPrice) * 100), subColor: 'var(--c-danger)' },
    ]

    return (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: '10px', marginBottom: '20px' }}>
            {stats.map(({ label, value, color, sub, subColor }) => (
                <div key={label} style={{ ...card, padding: '14px 16px' }}>
                    <div style={{ fontSize: '11px', color: 'var(--c-muted)', marginBottom: '4px' }}>{label}</div>
                    <div style={{ fontSize: '16px', fontWeight: 700, color: color ?? 'var(--c-text)' }}>{value}</div>
                    {sub && <div style={{ fontSize: '11px', color: subColor ?? 'var(--c-muted)', marginTop: '2px' }}>{sub}</div>}
                </div>
            ))}
        </div>
    )
}

// ── 主元件 ─────────────────────────────────────────────────────────────────

const FILTER_OPTIONS = [
    { label: '7 天', days: 7 },
    { label: '14 天', days: 14 },
    { label: '30 天', days: 30 },
    { label: '90 天', days: 90 },
    { label: '180 天', days: 180 },
    { label: '1 年', days: 365 },
    { label: '全部', days: Infinity },
]

const DEFAULT_ALERT_CONFIG: AlertConfig = {
    watchDays: 14,
    riseThreshold: 10,
    dropThreshold: 0,
}

export default function SoldTracker() {
    const [allSold, setAllSold] = useState<SoldRecord[]>([])
    const [loading, setLoading] = useState(true)
    const [priceLoading, setPriceLoading] = useState(false)
    const [lastUpdated, setLastUpdated] = useState('')
    const [filterDays, setFilterDays] = useState(90)
    const [sortBy, setSortBy] = useState<'date' | 'change' | 'cost'>('date')
    const [verdictThreshold, setVerdictThreshold] = useState(3)
    const [alertConfig, setAlertConfig] = useState<AlertConfig>(DEFAULT_ALERT_CONFIG)
    const [dismissedAlerts, setDismissedAlerts] = useState<Set<string>>(new Set())

    // ✅ 1-3：報價統一走 PriceContext（寫回 lastPrices、跨頁同步、不重複扣額度）
    const { updatePrices } = usePrices()

    // ── 通知設定持久化（與儀表板共用 settings/soldAlert）──────────────────────
    useEffect(() => {
        getDoc(userDocNested(investDB, 'settings', 'soldAlert'))
            .then(snap => {
                if (!snap.exists()) return
                // ✅ v2.1：逐欄位驗證型別後建構，取代 spread Record<string, unknown>
                //（spread 索引簽名物件會讓欄位型別退化，且無法擋掉 DB 內的非法值）
                const d = snap.data() as Record<string, unknown>
                setAlertConfig({
                    watchDays: typeof d.watchDays === 'number' && d.watchDays >= 1
                        ? d.watchDays : DEFAULT_ALERT_CONFIG.watchDays,
                    riseThreshold: typeof d.riseThreshold === 'number' && d.riseThreshold > 0
                        ? d.riseThreshold : DEFAULT_ALERT_CONFIG.riseThreshold,
                    dropThreshold: typeof d.dropThreshold === 'number' && d.dropThreshold >= 0
                        ? d.dropThreshold : DEFAULT_ALERT_CONFIG.dropThreshold,
                })
                // 決策判斷閾值與通知設定共用同一份文件，重整後不再回到預設 3%
                if (typeof d.verdictThreshold === 'number' && d.verdictThreshold >= 0.5) {
                    setVerdictThreshold(d.verdictThreshold)
                }
            })
            .catch(() => { })
    }, [])

    const updateAlertConfig = useCallback((c: AlertConfig) => {
        setAlertConfig(c)
        setDoc(userDocNested(investDB, 'settings', 'soldAlert'), c, { merge: true }).catch(() => { })
    }, [])

    const updateVerdictThreshold = useCallback((v: number) => {
        setVerdictThreshold(v)
        setDoc(userDocNested(investDB, 'settings', 'soldAlert'), { verdictThreshold: v }, { merge: true }).catch(() => { })
    }, [])

    // ── 載入 ──────────────────────────────────────────────────────────────

    const load = useCallback(async () => {
        setLoading(true)
        try {
            // ✅ 1-1：改走 investData 共用快取（TTL 內與其他頁共用同一份 trades，
            //         不再各自 getDocs 全量讀取）。'desc' 與原 orderBy('date','desc') 行為一致。
            const trades = await fetchTrades<Trade>('desc')
            setAllSold(trades
                .filter(t => t.type === 'sell')
                .map(t => ({
                    id: t.id!, date: t.date, code: t.code, name: t.name,
                    soldPrice: t.price, shares: t.shares, soldNet: t.total,
                    note: t.note, currentPrice: null, daysSinceSold: daysSince(t.date),
                })))
        } finally {
            setLoading(false)
        }
    }, [])

    useEffect(() => { load() }, [load])

    // ── 更新現價 ──────────────────────────────────────────────────────────

    const refreshPrices = useCallback(async () => {
        if (allSold.length === 0) return
        setPriceLoading(true)
        setDismissedAlerts(new Set()) // 每次刷新重新掃描通知
        try {
            const codes = [...new Set(allSold.map(r => r.code))]
            // ✅ 1-3：經 PriceContext 取價（內部仍走 Fugle 節流），並同步觸發自動快照
            const quotes = await updatePrices(codes)
            setAllSold(prev => prev.map(r => ({ ...r, currentPrice: quotes[r.code] ?? r.currentPrice })))
            setLastUpdated(new Date().toLocaleString('zh-TW'))
        } finally {
            setPriceLoading(false)
        }
    }, [allSold, updatePrices])

    // ── 通知計算 ──────────────────────────────────────────────────────────

    const activeAlerts: AlertItem[] = allSold
        .filter(r => r.currentPrice != null && r.daysSinceSold <= alertConfig.watchDays && !dismissedAlerts.has(r.code + r.date))
        .flatMap(r => {
            const pct = ((r.currentPrice! - r.soldPrice) / r.soldPrice) * 100
            const items: AlertItem[] = []
            if (pct >= alertConfig.riseThreshold) items.push({ record: r, changePct: pct, type: 'rise' })
            if (alertConfig.dropThreshold > 0 && pct <= -alertConfig.dropThreshold) items.push({ record: r, changePct: pct, type: 'drop' })
            return items
        })
        .sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct))

    const handleDismissAlert = (code: string, date: string) => {
        setDismissedAlerts(prev => new Set([...prev, code + date]))
    }

    // ── 篩選 + 排序 ───────────────────────────────────────────────────────

    const filtered = allSold
        .filter(r => r.daysSinceSold <= filterDays)
        .sort((a, b) => {
            if (sortBy === 'date') return new Date(b.date).getTime() - new Date(a.date).getTime()
            if (sortBy === 'change') {
                const ca = a.currentPrice != null ? ((a.currentPrice - a.soldPrice) / a.soldPrice) : -Infinity
                const cb = b.currentPrice != null ? ((b.currentPrice - b.soldPrice) / b.soldPrice) : -Infinity
                return cb - ca
            }
            if (sortBy === 'cost') {
                const ca = a.currentPrice != null ? (a.currentPrice - a.soldPrice) * a.shares : -Infinity
                const cb = b.currentPrice != null ? (b.currentPrice - b.soldPrice) * b.shares : -Infinity
                return cb - ca
            }
            return 0
        })

    // ── 渲染 ──────────────────────────────────────────────────────────────

    return (
        <div style={{ padding: '24px', maxWidth: '920px', margin: '0 auto' }}>
            <style>{`@keyframes spin { from { transform: rotate(0deg) } to { transform: rotate(360deg) } }`}</style>

            {/* 標題列 */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '20px', flexWrap: 'wrap', gap: '12px' }}>
                <div>
                    <h1 style={{ fontSize: '20px', fontWeight: 700, color: 'var(--c-text)', margin: 0 }}>賣出追蹤</h1>
                    <p style={{ fontSize: '13px', color: 'var(--c-muted)', margin: '4px 0 0' }}>
                        觀察賣出後的股票後續走勢，反省操作決策
                    </p>
                </div>
                <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
                    {lastUpdated && <span style={{ fontSize: '11px', color: 'var(--c-muted)' }}>更新：{lastUpdated}</span>}
                    {activeAlerts.length > 0 && (
                        <span style={{ fontSize: '11px', fontWeight: 700, padding: '4px 10px', borderRadius: '20px', backgroundColor: 'color-mix(in srgb, var(--c-danger) 15%, transparent)', color: 'var(--c-danger)', display: 'flex', alignItems: 'center', gap: '4px' }}>
                            <Bell size={12} /> {activeAlerts.length} 筆波動通知
                        </span>
                    )}
                    <button onClick={refreshPrices} disabled={priceLoading || loading}
                        style={btn('var(--c-accent)', { opacity: priceLoading ? 0.6 : 1 })}>
                        <RefreshCw size={14} style={{ animation: priceLoading ? 'spin 1s linear infinite' : 'none' }} />
                        {priceLoading ? '更新中...' : '更新現價'}
                    </button>
                </div>
            </div>

            {/* 通知面板（有通知才顯示） */}
            <AlertPanel
                alerts={activeAlerts}
                config={alertConfig}
                onConfigChange={updateAlertConfig}
                onDismiss={handleDismissAlert}
            />

            {/* 決策閾值說明列 */}
            {!loading && allSold.length > 0 && (
                <VerdictLegend threshold={verdictThreshold} onChangeThreshold={updateVerdictThreshold} />
            )}

            {/* 篩選條 */}
            <div style={{ display: 'flex', gap: '6px', marginBottom: '16px', flexWrap: 'wrap', alignItems: 'center' }}>
                <span style={{ fontSize: '12px', color: 'var(--c-muted)' }}>追蹤期間：</span>
                {FILTER_OPTIONS.map(({ label, days }) => (
                    <button key={label} onClick={() => setFilterDays(days)}
                        style={{
                            border: `1px solid ${filterDays === days ? 'var(--c-accent)' : 'var(--c-border)'}`,
                            borderRadius: '6px', padding: '4px 10px', fontSize: '12px', cursor: 'pointer',
                            backgroundColor: filterDays === days ? 'color-mix(in srgb, var(--c-accent) 15%, transparent)' : 'transparent',
                            color: filterDays === days ? 'var(--c-accent)' : 'var(--c-muted)',
                        }}>
                        {label}
                    </button>
                ))}
                <div style={{ marginLeft: 'auto', display: 'flex', gap: '6px', alignItems: 'center' }}>
                    <span style={{ fontSize: '12px', color: 'var(--c-muted)' }}>排序：</span>
                    {[
                        { key: 'date', label: '賣出日' },
                        { key: 'change', label: '漲跌幅' },
                        { key: 'cost', label: '機會損益' },
                    ].map(({ key, label }) => (
                        <button key={key} onClick={() => setSortBy(key as 'date' | 'change' | 'cost')}
                            style={{
                                border: `1px solid ${sortBy === key ? 'var(--c-accent)' : 'var(--c-border)'}`,
                                borderRadius: '6px', padding: '4px 10px', fontSize: '12px', cursor: 'pointer',
                                backgroundColor: sortBy === key ? 'color-mix(in srgb, var(--c-accent) 15%, transparent)' : 'transparent',
                                color: sortBy === key ? 'var(--c-accent)' : 'var(--c-muted)',
                            }}>
                            {label}
                        </button>
                    ))}
                </div>
            </div>

            {/* 載入中 */}
            {loading && (
                <div style={{ textAlign: 'center', padding: '60px', color: 'var(--c-muted)' }}>
                    <RefreshCw size={24} style={{ animation: 'spin 1s linear infinite', marginBottom: '12px' }} />
                    <div>載入買賣紀錄中...</div>
                </div>
            )}

            {/* 無資料 */}
            {!loading && allSold.length === 0 && (
                <div style={{ ...card, textAlign: 'center', padding: '60px', color: 'var(--c-muted)' }}>
                    <TrendingDown size={32} style={{ marginBottom: '12px', opacity: 0.4 }} />
                    <div style={{ fontSize: '15px' }}>尚無賣出紀錄</div>
                    <div style={{ fontSize: '12px', marginTop: '6px' }}>至買賣紀錄頁面新增賣出交易後，此處將自動顯示</div>
                </div>
            )}

            {!loading && allSold.length > 0 && filtered.length === 0 && (
                <div style={{ ...card, textAlign: 'center', padding: '40px', color: 'var(--c-muted)' }}>
                    <div>此期間範圍內無賣出紀錄</div>
                    <div style={{ fontSize: '12px', marginTop: '6px' }}>請調整追蹤期間篩選</div>
                </div>
            )}

            {/* 統計摘要 + 列表 */}
            {!loading && filtered.length > 0 && (
                <>
                    <SummaryBar records={filtered} verdictThreshold={verdictThreshold} />
                    <div style={{ fontSize: '11px', color: 'var(--c-muted)', marginBottom: '12px' }}>
                        點擊每列可展開 K 線走勢圖 · 共 {filtered.length} 筆
                        {filterDays !== Infinity && `（近 ${filterDays} 天）`}
                    </div>
                    <div>
                        {filtered.map(record => (
                            <SoldCard key={record.id + record.date} record={record} verdictThreshold={verdictThreshold} />
                        ))}
                    </div>
                </>
            )}
        </div>
    )
}