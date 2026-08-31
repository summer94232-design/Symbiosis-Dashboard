import { useState, useEffect, useRef } from 'react'
import { getDocs, setDoc, deleteDoc, updateDoc } from 'firebase/firestore'
import { investDB } from '../../lib/firebase'
import { userCol, userDoc } from '../../lib/userDB'
import { getHistoricalCandles } from '../../lib/fugle'
import { getForeignQuotes } from '../../lib/foreignQuote'
import { calcMarketCap, formatMarketCap } from '../../lib/marketCap'
import { toLocalDateString } from '../../lib/date'
import { useMarketCap } from '../../MarketCapContext'
import {
    Plus, Trash2, RefreshCw, TrendingUp, Pencil, Check, X,
    FileText, LayoutGrid, Table2, Tag, ChevronDown, ChevronRight, Activity, BarChart2, Landmark
} from 'lucide-react'
import { usePrices } from '../../PriceContext'
import { useInvestSync } from '../../InvestSyncContext'

interface WatchItem {
    code: string
    name: string
    market: 'tw' | 'jp' | 'us'
    targetHigh?: number
    targetLow?: number
    note?: string
    currentPrice?: number
    addedAt: string
    group?: string
}

interface MAData {
    ma5: number | null
    ma10: number | null
    ma20: number | null
}

interface ChartBar {
    date: string
    close: number
    volume: number
}

const UNGROUPED = '未分類'
const card: React.CSSProperties = { backgroundColor: 'var(--c-sidebar)', border: '1px solid var(--c-border)', borderRadius: '12px', padding: '20px' }
const inp: React.CSSProperties = { backgroundColor: 'var(--c-bg)', border: '1px solid var(--c-border)', borderRadius: '8px', padding: '8px 12px', color: 'var(--c-text)', fontSize: '14px', width: '100%', outline: 'none', boxSizing: 'border-box' }
const lbl: React.CSSProperties = { fontSize: '12px', color: 'var(--c-muted)', display: 'block', marginBottom: '4px' }
const btn = (color: string): React.CSSProperties => ({ backgroundColor: color, border: 'none', borderRadius: '8px', padding: '8px 16px', color: '#fff', fontSize: '14px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px' })

const MARKETS = {
    tw: { label: '台股 TW', color: 'var(--c-accent)', bg: 'color-mix(in srgb, var(--c-accent) 12%, transparent)', activeColor: 'var(--c-accent)' },
    jp: { label: '日股 JP', color: 'var(--c-warning)', bg: 'color-mix(in srgb, var(--c-warning) 12%, transparent)', activeColor: 'var(--c-warning)' },
    us: { label: '美股 US', color: '#60a5fa', bg: 'rgba(96,165,250,0.12)', activeColor: '#60a5fa' },
} as const

type MarketKey = keyof typeof MARKETS

function toYahooSymbol(code: string, market: MarketKey): string {
    if (market === 'jp') return `${code}.T`
    return code
}

function calcMA(closes: number[], period: number): number | null {
    if (closes.length < period) return null
    const slice = closes.slice(-period)
    return slice.reduce((s, v) => s + v, 0) / period
}

function MarketBadge({ market }: { market: MarketKey }) {
    const m = MARKETS[market] || MARKETS.tw
    return (
        <span style={{ fontSize: '10px', fontWeight: 700, color: m.color, backgroundColor: m.bg, borderRadius: '4px', padding: '1px 5px', flexShrink: 0 }}>
            {market.toUpperCase()}
        </span>
    )
}

// ── 小線圖元件 ────────────────────────────────────────────────────
function MiniChart({ data, market }: { data: ChartBar[]; market: MarketKey }) {
    const [tooltip, setTooltip] = useState<{ i: number; x: number; y: number } | null>(null)
    const svgRef = useRef<SVGSVGElement>(null)

    if (!data || data.length < 2) {
        return (
            <div style={{ height: '80px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <span style={{ fontSize: '11px', color: 'var(--c-dim)' }}>無圖表資料</span>
            </div>
        )
    }

    const W = 220, H = 80
    const PRICE_H = 52   // 折線區高度
    const VOL_H = 18     // 成交量區高度
    const GAP = 6        // 中間間距
    const PAD_X = 4

    const closes = data.map(d => d.close)
    const minC = Math.min(...closes)
    const maxC = Math.max(...closes)
    const rangeC = maxC - minC || 1

    const volumes = data.map(d => d.volume)
    const maxV = Math.max(...volumes) || 1

    const n = data.length
    const step = (W - PAD_X * 2) / (n - 1)

    // 收盤價折線座標
    const pts = closes.map((c, i) => ({
        x: PAD_X + i * step,
        y: PRICE_H - ((c - minC) / rangeC) * (PRICE_H - 8) - 4,
    }))

    const polyline = pts.map(p => `${p.x},${p.y}`).join(' ')

    // 是否上漲（首→末）
    const isUp = closes[closes.length - 1] >= closes[0]
    const lineColor = isUp ? 'var(--c-positive)' : 'var(--c-danger)'
    const fillColor = isUp ? 'rgba(0,200,150,0.08)' : 'rgba(255,87,87,0.08)'

    // 填色路徑
    const fillPath = `M${pts[0].x},${PRICE_H} ` +
        pts.map(p => `L${p.x},${p.y}`).join(' ') +
        ` L${pts[pts.length - 1].x},${PRICE_H} Z`

    // 成交量柱狀
    const barW = Math.max(2, step * 0.6)
    const volBars = data.map((d, i) => ({
        x: PAD_X + i * step - barW / 2,
        h: (d.volume / maxV) * VOL_H,
        vol: d.volume,
    }))

    const volY = PRICE_H + GAP

    // tooltip 目標點
    const hovered = tooltip !== null ? data[tooltip.i] : null

    const formatPrice = (v: number) =>
        market === 'jp' ? Math.round(v).toLocaleString() : v.toFixed(2)

    const formatVol = (v: number) => {
        if (v >= 1e8) return `${(v / 1e8).toFixed(1)}億`
        if (v >= 1e4) return `${(v / 1e4).toFixed(0)}萬`
        return v.toLocaleString()
    }

    return (
        <div style={{ position: 'relative', userSelect: 'none' }}>
            {/* tooltip */}
            {hovered && (
                <div style={{
                    position: 'absolute',
                    top: -2,
                    left: tooltip!.x < W / 2 ? tooltip!.x + 8 : undefined,
                    right: tooltip!.x >= W / 2 ? W - tooltip!.x + 8 : undefined,
                    backgroundColor: 'var(--c-sidebar)',
                    border: '1px solid var(--c-border)',
                    borderRadius: '6px',
                    padding: '5px 8px',
                    fontSize: '10px',
                    color: 'var(--c-text)',
                    pointerEvents: 'none',
                    whiteSpace: 'nowrap',
                    zIndex: 10,
                    lineHeight: 1.7,
                }}>
                    <div style={{ color: 'var(--c-muted)' }}>{hovered.date}</div>
                    <div>收盤 <span style={{ color: lineColor, fontWeight: 700 }}>{formatPrice(hovered.close)}</span></div>
                    <div>量 <span style={{ color: 'var(--c-purple)' }}>{formatVol(hovered.volume)}</span></div>
                </div>
            )}

            <svg
                ref={svgRef}
                width="100%"
                viewBox={`0 0 ${W} ${H}`}
                style={{ display: 'block', overflow: 'visible' }}
                onMouseLeave={() => setTooltip(null)}
                onMouseMove={e => {
                    const rect = svgRef.current?.getBoundingClientRect()
                    if (!rect) return
                    const ratio = W / rect.width
                    const mx = (e.clientX - rect.left) * ratio
                    const i = Math.max(0, Math.min(n - 1, Math.round((mx - PAD_X) / step)))
                    setTooltip({ i, x: pts[i].x / ratio * (rect.width / W), y: pts[i].y })
                }}
            >
                {/* 填色背景 */}
                <path d={fillPath} fill={fillColor} />

                {/* 折線 */}
                <polyline points={polyline} fill="none" stroke={lineColor} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />

                {/* 成交量柱狀 */}
                {volBars.map((b, i) => (
                    <rect
                        key={i}
                        x={b.x}
                        y={volY + (VOL_H - b.h)}
                        width={barW}
                        height={b.h}
                        fill={tooltip?.i === i ? 'var(--c-purple)' : 'rgba(167,139,250,0.35)'}
                        rx="1"
                    />
                ))}

                {/* hover 垂直線 + 圓點 */}
                {tooltip !== null && (
                    <>
                        <line
                            x1={pts[tooltip.i].x} y1={0}
                            x2={pts[tooltip.i].x} y2={H}
                            stroke="var(--c-dim)" strokeWidth="1" strokeDasharray="3,2"
                        />
                        <circle
                            cx={pts[tooltip.i].x}
                            cy={pts[tooltip.i].y}
                            r="3"
                            fill={lineColor}
                            stroke="var(--c-sidebar)"
                            strokeWidth="1.5"
                        />
                    </>
                )}
            </svg>

            {/* 首尾價格標示 */}
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '2px' }}>
                <span style={{ fontSize: '9px', color: 'var(--c-dim)' }}>{data[0]?.date?.slice(5)}</span>
                <span style={{ fontSize: '9px', color: 'var(--c-dim)' }}>{data[data.length - 1]?.date?.slice(5)}</span>
            </div>
        </div>
    )
}

function DistanceBar({ current, target, type }: { current: number; target: number; type: 'high' | 'low' }) {
    const pct = ((target - current) / current * 100)
    const absPct = Math.abs(pct)
    const reached = type === 'high' ? current >= target : current <= target
    const near = !reached && absPct <= 10
    const barColor = reached ? (type === 'high' ? 'var(--c-positive)' : 'var(--c-danger)') : near ? 'var(--c-warning)' : 'var(--c-accent)'
    const fill = Math.min(100, type === 'high' ? (current / target) * 100 : (target / current) * 100)
    const sign = pct > 0 ? '+' : ''
    return (
        <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
                <span style={{ fontSize: '11px', color: 'var(--c-muted)' }}>{type === 'high' ? '上標' : '下標'} {target}</span>
                <span style={{ fontSize: '11px', fontWeight: 600, color: reached ? barColor : near ? 'var(--c-warning)' : 'var(--c-muted)' }}>
                    {reached ? '✓ 達標' : `${sign}${pct.toFixed(1)}%`}
                </span>
            </div>
            <div style={{ height: '5px', backgroundColor: 'var(--c-border)', borderRadius: '3px', overflow: 'hidden' }}>
                <div style={{ height: '100%', width: `${fill}%`, backgroundColor: barColor, borderRadius: '3px', transition: 'width 0.4s ease' }} />
            </div>
        </div>
    )
}

function TargetCell({ current, target, type }: { current?: number; target: number; type: 'high' | 'low' }) {
    if (!current) return (
        <div>
            <span style={{ fontSize: '12px', fontWeight: 600, color: type === 'high' ? 'var(--c-positive)' : 'var(--c-danger)' }}>{target}</span>
            <span style={{ fontSize: '10px', color: 'var(--c-dim)', marginLeft: '4px' }}>—</span>
        </div>
    )
    const pct = (target - current) / current * 100
    const reached = type === 'high' ? current >= target : current <= target
    const near = !reached && Math.abs(pct) <= 10
    const barColor = reached ? (type === 'high' ? 'var(--c-positive)' : 'var(--c-danger)') : near ? 'var(--c-warning)' : 'var(--c-accent)'
    const textColor = reached ? barColor : near ? 'var(--c-warning)' : 'var(--c-muted)'
    const fill = Math.min(100, type === 'high' ? (current / target) * 100 : (target / current) * 100)
    return (
        <div style={{ minWidth: '90px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '6px' }}>
                <span style={{ fontSize: '12px', fontWeight: 600, color: type === 'high' ? 'var(--c-positive)' : 'var(--c-danger)' }}>{target}</span>
                <span style={{ fontSize: '10px', fontWeight: 600, color: textColor }}>
                    {reached ? '✓' : `${pct > 0 ? '+' : ''}${pct.toFixed(1)}%`}
                </span>
            </div>
            <div style={{ height: '3px', backgroundColor: 'var(--c-border)', borderRadius: '2px', marginTop: '3px', overflow: 'hidden' }}>
                <div style={{ height: '100%', width: `${fill}%`, backgroundColor: barColor, borderRadius: '2px' }} />
            </div>
        </div>
    )
}

function MABadge({ label, value, currentPrice }: { label: string; value: number | null; currentPrice?: number }) {
    if (value === null) return <span style={{ fontSize: '10px', color: 'var(--c-dim)' }}>{label}:—</span>
    const above = currentPrice ? currentPrice > value : null
    const color = above === null ? 'var(--c-muted)' : above ? 'var(--c-positive)' : 'var(--c-danger)'
    return (
        <span style={{ fontSize: '10px', color, backgroundColor: `${color}15`, borderRadius: '4px', padding: '1px 5px', fontWeight: 600 }}>
            {label}:{value.toFixed(1)}
        </span>
    )
}

function TableRow({ item, ma, marketCap, onEdit, onDelete }: {
    item: WatchItem; ma: MAData | null; marketCap: number | null
    onEdit: (item: WatchItem) => void; onDelete: (code: string) => void
}) {
    const { code, name, currentPrice, targetHigh, targetLow, group, market } = item
    const reachedHigh = !!(currentPrice && targetHigh && currentPrice >= targetHigh)
    const reachedLow = !!(currentPrice && targetLow && currentPrice <= targetLow)
    const rowBg = reachedHigh ? 'rgba(0,200,150,0.06)' : reachedLow ? 'rgba(255,87,87,0.06)' : 'transparent'
    const leftBorder = reachedHigh ? '2px solid var(--c-positive)' : reachedLow ? '2px solid var(--c-danger)' : '2px solid transparent'
    const isTW = market === 'tw'

    return (
        <tr style={{ backgroundColor: rowBg, borderBottom: '1px solid var(--c-border)' }}>
            <td style={{ padding: '6px 10px 6px 12px', whiteSpace: 'nowrap', borderLeft: leftBorder }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <MarketBadge market={market || 'tw'} />
                    <span style={{ fontWeight: 700, color: 'var(--c-accent)', fontSize: '13px' }}>{code}</span>
                    <span style={{ fontSize: '11px', color: 'var(--c-muted)' }}>{name}</span>
                    {group && group !== UNGROUPED &&
                        <span style={{ fontSize: '10px', backgroundColor: 'color-mix(in srgb, var(--c-accent) 12%, transparent)', color: 'var(--c-accent)', borderRadius: '6px', padding: '0px 5px' }}>{group}</span>}
                </div>
            </td>
            <td style={{ padding: '6px 10px', textAlign: 'right', fontWeight: 700, fontSize: '13px', color: 'var(--c-text)', whiteSpace: 'nowrap' }}>
                {currentPrice
                    ? (market === 'jp' ? <span>{Math.round(currentPrice).toLocaleString()} <span style={{ fontSize: '10px', color: 'var(--c-dim)' }}>円</span></span> : currentPrice.toFixed(2))
                    : <span style={{ color: 'var(--c-dim)' }}>—</span>}
            </td>
            <td style={{ padding: '6px 10px', textAlign: 'right', fontSize: '12px', color: 'var(--c-muted)', whiteSpace: 'nowrap' }}>
                {!isTW ? <span style={{ fontSize: '10px', color: 'var(--c-dim)' }}>不支援</span> : formatMarketCap(marketCap)}
            </td>
            <td style={{ padding: '6px 10px', whiteSpace: 'nowrap' }}>
                {!isTW ? <span style={{ fontSize: '10px', color: 'var(--c-dim)' }}>不支援</span>
                    : ma ? (
                        <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
                            <MABadge label="5MA" value={ma.ma5} currentPrice={currentPrice} />
                            <MABadge label="10MA" value={ma.ma10} currentPrice={currentPrice} />
                            <MABadge label="20MA" value={ma.ma20} currentPrice={currentPrice} />
                        </div>
                    ) : <span style={{ fontSize: '10px', color: 'var(--c-dim)' }}>—</span>}
            </td>
            <td style={{ padding: '6px 10px' }}>
                {targetLow ? <TargetCell current={currentPrice} target={targetLow} type="low" /> : <span style={{ fontSize: '11px', color: 'var(--c-dim)' }}>—</span>}
            </td>
            <td style={{ padding: '6px 10px' }}>
                {targetHigh ? <TargetCell current={currentPrice} target={targetHigh} type="high" /> : <span style={{ fontSize: '11px', color: 'var(--c-dim)' }}>—</span>}
            </td>
            <td style={{ padding: '6px 8px', textAlign: 'center', whiteSpace: 'nowrap' }}>
                <button onClick={() => onEdit(item)} style={{ background: 'none', border: 'none', color: 'var(--c-dim)', cursor: 'pointer', padding: '2px 3px' }}><Pencil size={11} /></button>
                <button onClick={() => onDelete(code)} style={{ background: 'none', border: 'none', color: 'var(--c-dim)', cursor: 'pointer', padding: '2px 3px' }}><Trash2 size={11} /></button>
            </td>
        </tr>
    )
}

// ── 主元件 ────────────────────────────────────────────────────────
export default function Watchlist() {
    const { version: syncVersion } = useInvestSync()
    const { prices, lastUpdated, priceLoading, updatePrices: ctxUpdatePrices } = usePrices()
    const { shares: sharesData, sharesLoading, updateShares } = useMarketCap()

    const [items, setItems] = useState<WatchItem[]>([])
    const [loading, setLoading] = useState(true)
    const [showForm, setShowForm] = useState(false)
    const [editingCode, setEditingCode] = useState<string | null>(null)
    const [expandedNote, setExpandedNote] = useState<string | null>(null)
    const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set())
    const [stockDict, setStockDict] = useState<Record<string, string>>({})
    const [viewMode, setViewMode] = useState<'card' | 'table'>('card')
    const [filterGroup, setFilterGroup] = useState<string>('all')

    const [maData, setMaData] = useState<Record<string, MAData>>({})
    const [maLoading, setMaLoading] = useState(false)
    const [maUpdatedAt, setMaUpdatedAt] = useState('')

    // 小線圖資料
    const [chartData, setChartData] = useState<Record<string, ChartBar[]>>({})
    const [chartLoading, setChartLoading] = useState(false)
    const [chartUpdatedAt, setChartUpdatedAt] = useState('')

    // 市值資料（已發行股數，僅台股支援；來源：MOPS 公開資料）
    // → 已改用全站共用的 MarketCapContext（見上方 useMarketCap()），與產業地圖頁共用同一份快取

    const emptyForm = { code: '', name: '', market: 'tw' as MarketKey, targetHigh: '', targetLow: '', note: '', group: '' }
    const [form, setForm] = useState(emptyForm)

    const allGroups = Array.from(new Set(items.map(i => i.group || UNGROUPED))).sort()
    const MARKET_ORDER: MarketKey[] = ['tw', 'jp', 'us']

    const load = async () => {
        setLoading(true)
        const snap = await getDocs(userCol(investDB, 'watchlist'))
        const data = snap.docs.map(d => {
            const raw = d.data()
            return { code: d.id, market: 'tw' as MarketKey, ...raw } as WatchItem
        })
        data.forEach(item => {
            if (item.market === 'tw') {
                const ctxPrice = prices[item.code]
                if (ctxPrice !== null && ctxPrice !== undefined) item.currentPrice = ctxPrice
            }
        })
        setItems(data.sort((a, b) => {
            const gA = a.group || UNGROUPED; const gB = b.group || UNGROUPED
            return gA !== gB ? gA.localeCompare(gB) : a.code.localeCompare(b.code)
        }))
        const dictSnap = await getDocs(userCol(investDB, 'stockDict'))
        const dict: Record<string, string> = {}
        dictSnap.docs.forEach(d => { dict[d.id] = d.data().name })
        setStockDict(dict)
        setLoading(false)
    }

    useEffect(() => { void load() }, [syncVersion])

    useEffect(() => {
        if (Object.keys(prices).length === 0) return
        setItems(prev => prev.map(item => {
            if (item.market !== 'tw') return item
            const ctxPrice = prices[item.code]
            if (ctxPrice !== null && ctxPrice !== undefined) return { ...item, currentPrice: ctxPrice }
            return item
        }))
    }, [prices])

    // ★ 更新現價
    const handleUpdatePrices = async () => {
        if (items.length === 0) return
        const twCodes = items.filter(i => i.market === 'tw').map(i => i.code)
        const foreignItems = items.filter(i => i.market !== 'tw')
        if (twCodes.length > 0) await ctxUpdatePrices(twCodes)
        if (foreignItems.length > 0) {
            const yahooSymbols = foreignItems.map(i => toYahooSymbol(i.code, i.market))
            const quotes = await getForeignQuotes(yahooSymbols)
            setItems(prev => prev.map(item => {
                if (item.market === 'tw') return item
                const price = quotes[toYahooSymbol(item.code, item.market)]
                return price != null ? { ...item, currentPrice: price } : item
            }))
        }
    }

    // ★ 更新 MA（台股）
    const handleUpdateMA = async () => {
        const twItems = items.filter(i => i.market === 'tw')
        if (twItems.length === 0) return
        setMaLoading(true)
        try {
            const to = toLocalDateString()
            const from = toLocalDateString(new Date(Date.now() - 45 * 86400000))
            const results: Record<string, MAData> = {}
            await Promise.all(twItems.map(async item => {
                try {
                    const data = await getHistoricalCandles(item.code, from, to)
                    if (!data?.data?.length) { results[item.code] = { ma5: null, ma10: null, ma20: null }; return }
                    const closes: number[] = data.data.filter((d: any) => d.close != null).map((d: any) => d.close)
                    results[item.code] = { ma5: calcMA(closes, 5), ma10: calcMA(closes, 10), ma20: calcMA(closes, 20) }
                } catch { results[item.code] = { ma5: null, ma10: null, ma20: null } }
            }))
            setMaData(results)
            setMaUpdatedAt(new Date().toLocaleString('zh-TW'))
        } catch (err) { console.error(err) }
        setMaLoading(false)
    }

    // ★ 更新小線圖（10日歷史）
    const handleUpdateChart = async () => {
        if (items.length === 0) return
        setChartLoading(true)
        const results: Record<string, ChartBar[]> = {}

        const to = toLocalDateString()
        const from = toLocalDateString(new Date(Date.now() - 20 * 86400000)) // 多抓幾天保證有10個交易日

        await Promise.all(items.map(async item => {
            try {
                if (item.market === 'tw') {
                    // 台股：Fugle 歷史資料
                    const data = await getHistoricalCandles(item.code, from, to)
                    if (!data?.data?.length) return
                    const bars: ChartBar[] = data.data
                        .filter((d: any) => d.close != null && d.date != null)
                        .map((d: any) => ({ date: d.date, close: d.close, volume: d.volume ?? 0 }))
                        // ✅ 修正：確保資料由舊到新排序（左=最舊，右=最新）
                        .sort((a: ChartBar, b: ChartBar) => a.date.localeCompare(b.date))
                        .slice(-10)
                    results[item.code] = bars
                } else {
                    // 外股：透過 Netlify Function 避免 CORS
                    const symbol = toYahooSymbol(item.code, item.market)
                    const res = await fetch(
                        `/.netlify/functions/foreign-quote?type=chart&symbol=${encodeURIComponent(symbol)}`
                    )
                    if (!res.ok) return
                    const json = await res.json()
                    if (json.bars?.length) {
                        // ✅ 修正：確保資料由舊到新排序（左=最舊，右=最新）
                        results[item.code] = [...json.bars].sort(
                            (a: ChartBar, b: ChartBar) => a.date.localeCompare(b.date)
                        )
                    }
                }
            } catch (err) {
                console.error(`[chart] ${item.code}`, err)
            }
        }))

        setChartData(results)
        setChartUpdatedAt(new Date().toLocaleString('zh-TW'))
        setChartLoading(false)
    }

    // ★ 更新市值（僅台股，透過 MOPS 公開資料取得已發行股數；經由全站共用 Context，與產業地圖頁連動）
    const handleUpdateMarketCap = async () => {
        const twCodes = items.filter(i => i.market === 'tw').map(i => i.code)
        if (twCodes.length === 0) return
        try {
            await updateShares(twCodes)
        } catch (err) {
            console.error(err)
        }
    }

    const handleAdd = async () => {
        if (!form.code.trim()) return
        const code = form.code.trim().toUpperCase()
        const name = form.name.trim() || (form.market === 'tw' ? (stockDict[code] || code) : code)
        await setDoc(userDoc(investDB, 'watchlist', code), {
            name, market: form.market,
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
            note: form.note || null, name: form.name || item.name,
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
        setForm({ code: item.code, name: item.name, market: item.market || 'tw', targetHigh: item.targetHigh?.toString() || '', targetLow: item.targetLow?.toString() || '', note: item.note || '', group: item.group || '' })
    }

    const toggleGroup = (g: string) => {
        setCollapsedGroups(prev => { const next = new Set(prev); next.has(g) ? next.delete(g) : next.add(g); return next })
    }

    const getPriceStatus = (item: WatchItem) => {
        if (!item.currentPrice) return 'normal'
        if (item.targetHigh && item.currentPrice >= item.targetHigh) return 'high'
        if (item.targetLow && item.currentPrice <= item.targetLow) return 'low'
        return 'normal'
    }

    const grouped: Record<string, WatchItem[]> = {}
    const filtered = filterGroup === 'all' ? items : items.filter(i => (i.group || UNGROUPED) === filterGroup)
    filtered.forEach(item => { const g = item.group || UNGROUPED; if (!grouped[g]) grouped[g] = []; grouped[g].push(item) })
    const groupKeys = Object.keys(grouped).sort()
    const alertCount = items.filter(i => getPriceStatus(i) !== 'normal').length

    return (
        <>
            <style>{`
                .watch-grid { display: grid; gap: 8px; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); }
                @media (max-width: 700px) { .watch-grid { grid-template-columns: 1fr; } }
                .form-grid { display: grid; gap: 12px; grid-template-columns: 1fr 1fr; }
                @media (max-width: 600px) { .form-grid { grid-template-columns: 1fr; } }
                @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
                .watch-card { transition: box-shadow 0.2s, border-color 0.2s; }
                .watch-card:hover { box-shadow: 0 4px 20px rgba(0,0,0,0.3); }
                .overview-table { width: 100%; border-collapse: collapse; }
                .overview-table thead th { position: sticky; top: 0; background: var(--c-bg); z-index: 1; padding: 6px 10px; text-align: left; font-size: 11px; color: var(--c-muted); font-weight: 600; border-bottom: 1px solid var(--c-border); letter-spacing: 0.03em; text-transform: uppercase; }
                .overview-table tbody tr:hover td { background-color: rgba(79,142,247,0.05) !important; }
                .market-toggle { display: flex; border-radius: 8px; overflow: hidden; border: 1px solid var(--c-border); max-width: 280px; }
                .market-toggle button { flex: 1; padding: 8px 0; border: none; cursor: pointer; font-size: 12px; font-weight: 700; transition: background 0.15s, color 0.15s; }
            `}</style>

            <div style={{ padding: 'clamp(16px, 3vw, 32px)', maxWidth: '1400px', margin: '0 auto' }}>

                {/* 標題列 */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '20px', flexWrap: 'wrap', gap: '12px' }}>
                    <div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                            <h1 style={{ fontSize: 'clamp(18px, 2.5vw, 22px)', fontWeight: 700, color: 'var(--c-text)', margin: 0 }}>自選股追蹤</h1>
                            {alertCount > 0 && (
                                <span style={{ fontSize: '12px', backgroundColor: 'rgba(245,166,35,0.2)', color: 'var(--c-warning)', borderRadius: '10px', padding: '2px 10px', fontWeight: 600 }}>
                                    🔔 {alertCount} 檔達標
                                </span>
                            )}
                        </div>
                        <p style={{ fontSize: '13px', color: 'var(--c-muted)', margin: '4px 0 0' }}>
                        </p>
                    </div>
                    <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                        <div style={{ display: 'flex', backgroundColor: 'var(--c-bg)', borderRadius: '8px', padding: '3px', border: '1px solid var(--c-border)' }}>
                            <button onClick={() => setViewMode('card')} style={{ ...btn(viewMode === 'card' ? 'var(--c-border)' : 'transparent'), padding: '5px 10px', fontSize: '12px', borderRadius: '6px' }}><LayoutGrid size={13} />卡片</button>
                            <button onClick={() => setViewMode('table')} style={{ ...btn(viewMode === 'table' ? 'var(--c-border)' : 'transparent'), padding: '5px 10px', fontSize: '12px', borderRadius: '6px' }}><Table2 size={13} />一覽表</button>
                        </div>
                        <button onClick={handleUpdateChart} disabled={chartLoading || items.length === 0} style={{ ...btn('var(--c-card)'), border: '1px solid var(--c-border)' }}>
                            <BarChart2 size={14} style={{ animation: chartLoading ? 'spin 1s linear infinite' : 'none' }} />
                            {chartLoading ? '載入中...' : '更新線圖'}
                        </button>
                        <button onClick={handleUpdateMA} disabled={maLoading || items.length === 0} style={{ ...btn('var(--c-card)'), border: '1px solid var(--c-border)' }}>
                            <Activity size={14} style={{ animation: maLoading ? 'spin 1s linear infinite' : 'none' }} />
                            {maLoading ? 'MA 計算中...' : '更新 MA'}
                        </button>
                        <button onClick={handleUpdatePrices} disabled={priceLoading || items.length === 0} style={btn('var(--c-card)')}>
                            <RefreshCw size={14} style={{ animation: priceLoading ? 'spin 1s linear infinite' : 'none' }} />
                            {priceLoading ? '更新中...' : '更新現價'}
                        </button>
                        <button onClick={handleUpdateMarketCap} disabled={sharesLoading || items.length === 0} style={{ ...btn('var(--c-card)'), border: '1px solid var(--c-border)' }}>
                            <Landmark size={14} style={{ animation: sharesLoading ? 'spin 1s linear infinite' : 'none' }} />
                            {sharesLoading ? '載入中...' : '更新市值'}
                        </button>
                        <button onClick={() => { setShowForm(!showForm); setForm(emptyForm) }} style={btn('var(--c-accent)')}>
                            <Plus size={14} />{showForm ? '取消' : '新增自選股'}
                        </button>
                    </div>
                </div>

                {/* 族群篩選列 */}
                {allGroups.length > 1 && (
                    <div style={{ display: 'flex', gap: '8px', marginBottom: '16px', flexWrap: 'wrap', alignItems: 'center' }}>
                        <Tag size={13} style={{ color: 'var(--c-muted)', flexShrink: 0 }} />
                        {['all', ...allGroups].map(g => (
                            <button key={g} onClick={() => setFilterGroup(g)} style={{ ...btn(filterGroup === g ? 'var(--c-accent)' : 'var(--c-card)'), padding: '4px 12px', fontSize: '12px', borderRadius: '20px', border: `1px solid ${filterGroup === g ? 'var(--c-accent)' : 'var(--c-border)'}` }}>
                                {g === 'all' ? `全部 (${items.length})` : `${g} (${items.filter(i => (i.group || UNGROUPED) === g).length})`}
                            </button>
                        ))}
                    </div>
                )}

                {/* 新增表單 */}
                {showForm && (
                    <div style={{ ...card, marginBottom: '20px' }}>
                        <div style={{ fontSize: '14px', fontWeight: 600, color: 'var(--c-text)', marginBottom: '16px' }}>新增自選股</div>
                        <div style={{ marginBottom: '16px' }}>
                            <label style={lbl}>市場</label>
                            <div className="market-toggle">
                                {MARKET_ORDER.map(m => (
                                    <button key={m} onClick={() => setForm(f => ({ ...f, market: m, code: '', name: '' }))}
                                        style={{ background: form.market === m ? MARKETS[m].activeColor : 'var(--c-bg)', color: form.market === m ? '#fff' : 'var(--c-muted)' }}>
                                        {MARKETS[m].label}
                                    </button>
                                ))}
                            </div>
                        </div>
                        <div className="form-grid">
                            <div>
                                <label style={lbl}>
                                    股票代號 *
                                    <span style={{ color: 'var(--c-dim)', marginLeft: '6px', fontWeight: 400 }}>
                                        {form.market === 'tw' && '（如：2330）'}
                                        {form.market === 'jp' && '（如：7203，不需加 .T）'}
                                        {form.market === 'us' && '（如：AAPL）'}
                                    </span>
                                </label>
                                <input style={inp}
                                    placeholder={form.market === 'tw' ? '如：2330' : form.market === 'jp' ? '如：7203（豐田）' : '如：AAPL'}
                                    value={form.code}
                                    onChange={e => { const code = e.target.value.toUpperCase(); setForm(f => ({ ...f, code, name: f.market === 'tw' ? (stockDict[code] || f.name) : f.name })) }} />
                            </div>
                            <div>
                                <label style={lbl}>股票名稱</label>
                                <input style={inp} placeholder={form.market === 'tw' ? '自動帶入或手動輸入' : '請手動輸入（如：豐田）'}
                                    value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />
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
                                            style={{ ...btn(form.group === g ? 'var(--c-accent)' : 'var(--c-card)'), padding: '3px 10px', fontSize: '12px', borderRadius: '20px', border: `1px solid ${form.group === g ? 'var(--c-accent)' : 'var(--c-border)'}` }}>{g}</button>
                                    ))}
                                </div>
                                <input style={inp} placeholder="輸入新族群名稱，或選擇上方已有族群" value={form.group}
                                    onChange={e => setForm(f => ({ ...f, group: e.target.value }))} />
                            </div>
                            <div style={{ gridColumn: 'span 2' }}>
                                <label style={lbl}>評估筆記</label>
                                <textarea style={{ ...inp, minHeight: '60px', resize: 'vertical', fontFamily: 'sans-serif' }}
                                    placeholder="選填" value={form.note} onChange={e => setForm(f => ({ ...f, note: e.target.value }))} />
                            </div>
                        </div>
                        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '16px' }}>
                            <button style={btn('var(--c-border)')} onClick={() => { setShowForm(false); setForm(emptyForm) }}><X size={14} />取消</button>
                            <button style={btn(MARKETS[form.market].activeColor)} onClick={handleAdd}><Check size={14} />新增</button>
                        </div>
                    </div>
                )}

                {/* 載入中 / 空狀態 */}
                {loading ? (
                    <div style={{ textAlign: 'center', padding: '60px', color: 'var(--c-muted)' }}>
                        <RefreshCw size={24} style={{ animation: 'spin 1s linear infinite', marginBottom: '12px' }} />
                        <p>載入中...</p>
                    </div>
                ) : items.length === 0 ? (
                    <div style={{ ...card, textAlign: 'center', padding: '60px' }}>
                        <TrendingUp size={32} color="var(--c-border)" style={{ marginBottom: '16px' }} />
                        <p style={{ color: 'var(--c-muted)', fontSize: '15px', margin: '0 0 8px' }}>尚無自選股</p>
                        <p style={{ color: 'var(--c-dim)', fontSize: '13px', margin: 0 }}>點擊「新增自選股」開始追蹤</p>
                    </div>
                ) : viewMode === 'table' ? (
                    <div style={{ ...card, padding: '0', overflow: 'hidden' }}>
                        <div style={{ overflowX: 'auto', maxHeight: '70vh', overflowY: 'auto' }}>
                            <table className="overview-table">
                                <thead>
                                    <tr>
                                        <th>代號 / 名稱</th>
                                        <th style={{ textAlign: 'right' }}>現價</th>
                                        <th style={{ textAlign: 'right' }}>市值（億）</th>
                                        <th style={{ color: 'var(--c-purple)' }}>均線 (5/10/20MA)</th>
                                        <th>下標（買入）</th>
                                        <th>上標（賣出）</th>
                                        <th style={{ textAlign: 'center' }}>操作</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {filtered.map(item => (
                                        <TableRow
                                            key={item.code}
                                            item={item}
                                            ma={maData[item.code] || null}
                                            marketCap={item.market === 'tw' ? calcMarketCap(item.currentPrice, sharesData[item.code]) : null}
                                            onEdit={openEdit}
                                            onDelete={handleDelete}
                                        />
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </div>
                ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                        {groupKeys.map(groupName => {
                            const groupItems = grouped[groupName]
                            const isCollapsed = collapsedGroups.has(groupName)
                            return (
                                <div key={groupName}>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px', cursor: 'pointer' }} onClick={() => toggleGroup(groupName)}>
                                        {isCollapsed ? <ChevronRight size={14} color="var(--c-muted)" /> : <ChevronDown size={14} color="var(--c-muted)" />}
                                        <span style={{ fontSize: '13px', fontWeight: 600, color: groupName === UNGROUPED ? 'var(--c-muted)' : 'var(--c-accent)' }}>{groupName}</span>
                                        <span style={{ fontSize: '11px', color: 'var(--c-dim)' }}>{groupItems.length} 檔</span>
                                    </div>

                                    {!isCollapsed && (
                                        <div className="watch-grid">
                                            {groupItems.map(item => {
                                                const status = getPriceStatus(item)
                                                const isEditing = editingCode === item.code
                                                const borderColor = status === 'high' ? 'var(--c-positive)' : status === 'low' ? 'var(--c-danger)' : 'var(--c-border)'
                                                const ma = maData[item.code] || null
                                                const isTW = item.market === 'tw'
                                                const chart = chartData[item.code] || null
                                                const marketCap = isTW ? calcMarketCap(item.currentPrice, sharesData[item.code]) : null

                                                return (
                                                    <div key={item.code} className="watch-card" style={{ backgroundColor: 'var(--c-sidebar)', border: `1px solid ${borderColor}`, borderRadius: '10px', padding: '14px', display: 'flex', flexDirection: 'column', gap: '8px' }}>

                                                        {/* 第一行：市場 + 代號 + 名稱 + 操作 */}
                                                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                                                            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flex: 1, minWidth: 0 }}>
                                                                <MarketBadge market={item.market || 'tw'} />
                                                                <span style={{ fontWeight: 700, color: 'var(--c-accent)', fontSize: '14px' }}>{item.code}</span>
                                                                <span style={{ fontSize: '12px', color: 'var(--c-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.name}</span>
                                                            </div>
                                                            <div style={{ display: 'flex', gap: '4px', flexShrink: 0 }}>
                                                                <button onClick={() => openEdit(item)} style={{ background: 'none', border: 'none', color: 'var(--c-dim)', cursor: 'pointer', padding: '2px' }}><Pencil size={12} /></button>
                                                                <button onClick={() => handleDelete(item.code)} style={{ background: 'none', border: 'none', color: 'var(--c-dim)', cursor: 'pointer', padding: '2px' }}><Trash2 size={12} /></button>
                                                            </div>
                                                        </div>

                                                        {/* 現價 + 漲跌（與線圖連動顯示） */}
                                                        <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px' }}>
                                                            <span style={{ fontSize: '20px', fontWeight: 700, color: 'var(--c-text)', lineHeight: 1 }}>
                                                                {item.currentPrice
                                                                    ? (item.market === 'jp'
                                                                        ? <span>{Math.round(item.currentPrice).toLocaleString()} <span style={{ fontSize: '11px', color: 'var(--c-dim)' }}>円</span></span>
                                                                        : item.currentPrice.toFixed(2))
                                                                    : <span style={{ fontSize: '13px', color: 'var(--c-dim)' }}>—</span>}
                                                            </span>
                                                            {/* 10日漲跌幅 */}
                                                            {chart && chart.length >= 2 && (() => {
                                                                const chg = (chart[chart.length - 1].close - chart[0].close) / chart[0].close * 100
                                                                const color = chg >= 0 ? 'var(--c-positive)' : 'var(--c-danger)'
                                                                return <span style={{ fontSize: '11px', color, fontWeight: 600 }}>{chg >= 0 ? '+' : ''}{chg.toFixed(2)}% <span style={{ color: 'var(--c-dim)', fontWeight: 400 }}>10日</span></span>
                                                            })()}
                                                            {/* 市值（僅台股） */}
                                                            {isTW && marketCap != null && (
                                                                <span style={{ fontSize: '11px', color: 'var(--c-muted)' }}>
                                                                    市值 <span style={{ color: 'var(--c-text)', fontWeight: 600 }}>{formatMarketCap(marketCap)}</span>
                                                                </span>
                                                            )}
                                                        </div>

                                                        {/* 小線圖 */}
                                                        {chart && (
                                                            <div style={{ borderRadius: '6px', overflow: 'hidden' }}>
                                                                <MiniChart data={chart} market={item.market || 'tw'} />
                                                            </div>
                                                        )}

                                                        {/* MA（台股） */}
                                                        {isTW && ma && (
                                                            <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
                                                                <MABadge label="5MA" value={ma.ma5} currentPrice={item.currentPrice} />
                                                                <MABadge label="10MA" value={ma.ma10} currentPrice={item.currentPrice} />
                                                                <MABadge label="20MA" value={ma.ma20} currentPrice={item.currentPrice} />
                                                            </div>
                                                        )}

                                                        {/* 目標標籤 */}
                                                        <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
                                                            {item.targetLow && (
                                                                <span style={{ fontSize: '11px', color: 'var(--c-danger)', backgroundColor: 'rgba(255,87,87,0.08)', borderRadius: '6px', padding: '1px 6px' }}>
                                                                    ↓{item.targetLow}
                                                                    {item.currentPrice && <span style={{ color: 'var(--c-muted)', marginLeft: '2px' }}>({((item.targetLow - item.currentPrice) / item.currentPrice * 100).toFixed(1)}%)</span>}
                                                                </span>
                                                            )}
                                                            {item.targetHigh && (
                                                                <span style={{ fontSize: '11px', color: 'var(--c-positive)', backgroundColor: 'rgba(0,200,150,0.08)', borderRadius: '6px', padding: '1px 6px' }}>
                                                                    ↑{item.targetHigh}
                                                                    {item.currentPrice && <span style={{ color: 'var(--c-muted)', marginLeft: '2px' }}>({((item.targetHigh - item.currentPrice) / item.currentPrice * 100).toFixed(1)}%)</span>}
                                                                </span>
                                                            )}
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
                                                                <div style={{ flex: 1 }}>
                                                                    <label style={lbl}>名稱</label>
                                                                    <input style={inp} value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />
                                                                </div>
                                                                <div style={{ display: 'flex', gap: '8px' }}>
                                                                    <div style={{ flex: 1 }}>
                                                                        <label style={lbl}>上標價</label>
                                                                        <input type="number" style={inp} placeholder="賣出參考" value={form.targetHigh} onChange={e => setForm(f => ({ ...f, targetHigh: e.target.value }))} />
                                                                    </div>
                                                                    <div style={{ flex: 1 }}>
                                                                        <label style={lbl}>下標價</label>
                                                                        <input type="number" style={inp} placeholder="買入參考" value={form.targetLow} onChange={e => setForm(f => ({ ...f, targetLow: e.target.value }))} />
                                                                    </div>
                                                                </div>
                                                                <div>
                                                                    <label style={lbl}><Tag size={10} style={{ marginRight: '3px', verticalAlign: 'middle' }} />族群</label>
                                                                    <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginBottom: '6px' }}>
                                                                        {allGroups.filter(g => g !== UNGROUPED).map(g => (
                                                                            <button key={g} onClick={() => setForm(f => ({ ...f, group: f.group === g ? '' : g }))}
                                                                                style={{ ...btn(form.group === g ? 'var(--c-accent)' : 'var(--c-card)'), padding: '2px 8px', fontSize: '11px', borderRadius: '20px', border: `1px solid ${form.group === g ? 'var(--c-accent)' : 'var(--c-border)'}` }}>{g}</button>
                                                                        ))}
                                                                    </div>
                                                                    <input style={inp} placeholder="族群名稱" value={form.group} onChange={e => setForm(f => ({ ...f, group: e.target.value }))} />
                                                                </div>
                                                                <div>
                                                                    <label style={lbl}>評估筆記</label>
                                                                    <textarea style={{ ...inp, minHeight: '60px', resize: 'vertical', fontFamily: 'sans-serif' }}
                                                                        value={form.note} onChange={e => setForm(f => ({ ...f, note: e.target.value }))} />
                                                                </div>
                                                                <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
                                                                    <button style={{ ...btn('var(--c-border)'), fontSize: '12px', padding: '6px 12px' }} onClick={() => setEditingCode(null)}><X size={12} />取消</button>
                                                                    <button style={{ ...btn('var(--c-accent)'), fontSize: '12px', padding: '6px 12px' }} onClick={() => handleEdit(item.code)}><Check size={12} />儲存</button>
                                                                </div>
                                                            </div>
                                                        ) : (
                                                            <>
                                                                {item.note && (
                                                                    <div style={{ borderTop: '1px solid var(--c-border)', paddingTop: '6px', marginTop: '2px' }}>
                                                                        <button onClick={() => setExpandedNote(expandedNote === item.code ? null : item.code)}
                                                                            style={{ display: 'flex', alignItems: 'center', gap: '4px', background: 'none', border: 'none', color: 'var(--c-dim)', cursor: 'pointer', fontSize: '11px', padding: 0 }}>
                                                                            <FileText size={11} />筆記
                                                                            {expandedNote === item.code ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
                                                                        </button>
                                                                        {expandedNote === item.code && (
                                                                            <p style={{ fontSize: '11px', color: 'var(--c-muted)', margin: '4px 0 0', lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>{item.note}</p>
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
