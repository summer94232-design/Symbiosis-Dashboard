import { useState, useEffect, useRef } from 'react'
import { getDocs, orderBy, query, getDoc, setDoc } from 'firebase/firestore'
import { investDB } from '../../lib/firebase'
import { userCol, userDoc, userDocNested } from '../../lib/userDB'
import { calcPositions, type TradeRecord, type DividendRecord } from '../../lib/calc'
import { RefreshCw, TrendingUp, TrendingDown, Tag, Check, X } from 'lucide-react'
import { usePrices } from '../../PriceContext'

interface DisplayHolding {
    code: string
    name: string
    shares: number
    avgCost: number
    currentPrice: number | null
    marketValue: number
    totalCost: number
    marginAmount: number   // ✅ 新增：融資借款金額（0 = 現股）
    unrealizedPnL: number
    returnRate: number
}

function GroupCell({
    code, group, allGroups, onSave,
}: {
    code: string; group: string; allGroups: string[]; onSave: (code: string, group: string) => void
}) {
    const [editing, setEditing] = useState(false)
    const [value, setValue] = useState(group)
    const inputRef = useRef<HTMLInputElement>(null)
    const suggestions = Array.from(new Set([...allGroups, value].filter(Boolean)))

    useEffect(() => {
        if (editing) { setValue(group); setTimeout(() => inputRef.current?.focus(), 50) }
    }, [editing, group])

    const handleSave = () => { onSave(code, value.trim()); setEditing(false) }
    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter') handleSave()
        if (e.key === 'Escape') setEditing(false)
    }

    if (!editing) {
        return (
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer' }} onClick={() => setEditing(true)} title="點擊編輯族群">
                {group ? (
                    <span style={{ fontSize: '12px', color: '#a78bfa', backgroundColor: 'rgba(167,139,250,0.12)', padding: '2px 8px', borderRadius: '20px', fontWeight: 600 }}>
                        {group}
                    </span>
                ) : (
                    <span style={{ fontSize: '12px', color: '#3d4460' }}>+ 設定族群</span>
                )}
            </div>
        )
    }

    return (
        <div style={{ display: 'flex', alignItems: 'center', gap: '4px', minWidth: '150px' }}>
            <div style={{ position: 'relative', flex: 1 }}>
                <input
                    ref={inputRef}
                    value={value}
                    onChange={e => setValue(e.target.value)}
                    onKeyDown={handleKeyDown}
                    list={`group-list-${code}`}
                    placeholder="輸入或選擇族群"
                    style={{ backgroundColor: 'var(--c-bg)', border: '1px solid var(--c-accent)', borderRadius: '6px', padding: '4px 8px', color: 'var(--c-text)', fontSize: '12px', width: '100%', outline: 'none' }}
                />
                <datalist id={`group-list-${code}`}>
                    {suggestions.map(s => <option key={s} value={s} />)}
                </datalist>
            </div>
            <button onClick={handleSave} style={{ background: 'var(--c-positive)', border: 'none', borderRadius: '4px', padding: '4px 6px', cursor: 'pointer', display: 'flex', alignItems: 'center' }} title="儲存">
                <Check size={12} color="#fff" />
            </button>
            <button onClick={() => setEditing(false)} style={{ background: 'var(--c-border)', border: 'none', borderRadius: '4px', padding: '4px 6px', cursor: 'pointer', display: 'flex', alignItems: 'center' }} title="取消">
                <X size={12} color="var(--c-muted)" />
            </button>
        </div>
    )
}

// ✅ 融資損益率輔助函式：融資用自備款為分母，現股用全額成本
function calcReturnRate(unrealizedPnL: number, totalCost: number, marginAmount: number): number {
    const equity = totalCost - marginAmount  // 自備款 = 全額成本 - 融資借款
    const denominator = marginAmount > 0 ? equity : totalCost
    return denominator > 0 ? (unrealizedPnL / denominator) * 100 : 0
}

export default function Holdings() {
    // ── 全域現價 Context ──
    const { prices, lastUpdated, priceLoading, updatePrices: ctxUpdatePrices, loadCachedPrices } = usePrices()

    const [holdings, setHoldings] = useState<DisplayHolding[]>([])
    const [loading, setLoading] = useState(true)
    const [stockGroups, setStockGroups] = useState<Record<string, string>>({})
    const [groupSaving, setGroupSaving] = useState(false)

    const load = async () => {
        setLoading(true)
        try {
            const [snap, divSnap] = await Promise.all([
                getDocs(query(userCol(investDB, 'trades'), orderBy('date', 'asc'))),
                getDocs(userCol(investDB, 'dividends')),
            ])
            const trades = snap.docs.map(d => d.data() as TradeRecord)
            const dividends = divSnap.docs.map(d => d.data() as DividendRecord)
            const { holdings: positions } = calcPositions(trades, dividends)
            const activePositions = Object.values(positions).filter((pos: any) => pos.shares > 0)

            const priceDoc = await getDoc(userDocNested(investDB, 'settings', 'lastPrices'))
            const savedPrices: Record<string, any> = priceDoc.exists() ? priceDoc.data() : {}
            const savedAt = savedPrices._updatedAt || ''

            // ★ 把 Firebase 快取匯入全域 Context
            loadCachedPrices(savedPrices, savedAt)

            const groupDoc = await getDoc(userDocNested(investDB, 'settings', 'stockGroups'))
            const groups: Record<string, string> = groupDoc.exists() ? groupDoc.data() : {}
            setStockGroups(groups)

            const list: DisplayHolding[] = activePositions.map((pos: any) => {
                // 優先用 Context 現價（可能其他頁面已更新），fallback 到 Firebase 快取
                const ctxVal = prices[pos.code]
                const fbVal = savedPrices[pos.code]
                const currentPrice = ctxVal ?? (typeof fbVal === 'number' && fbVal > 0 ? fbVal : null)
                const marketValue = currentPrice !== null ? currentPrice * pos.shares : pos.totalCost
                const unrealizedPnL = currentPrice !== null ? marketValue - pos.totalCost : 0
                const marginAmount = pos.marginAmount ?? 0
                // ✅ 融資用自備款為分母，現股用全額成本
                const returnRate = calcReturnRate(unrealizedPnL, pos.totalCost, marginAmount)
                return {
                    code: pos.code, name: pos.name, shares: pos.shares,
                    avgCost: pos.avgCost, currentPrice, marketValue,
                    totalCost: pos.totalCost, marginAmount, unrealizedPnL, returnRate
                }
            }).sort((a, b) => b.marketValue - a.marketValue)

            setHoldings(list)
        } catch (err) { console.error(err) }
        setLoading(false)
    }

    // ★ 更新現價：委託 Context，用回傳的 quotes 同步更新本頁 holdings
    const handleUpdatePrices = async () => {
        const symbols = holdings.map(h => h.code)
        if (symbols.length === 0) return
        const quotes = await ctxUpdatePrices(symbols)

        setHoldings(prev => prev.map(h => {
            const currentPrice = quotes[h.code] ?? null
            const marketValue = currentPrice !== null ? currentPrice * h.shares : h.totalCost
            const unrealizedPnL = currentPrice !== null ? marketValue - h.totalCost : 0
            // ✅ 融資用自備款為分母，現股用全額成本
            const returnRate = calcReturnRate(unrealizedPnL, h.totalCost, h.marginAmount)
            return { ...h, currentPrice, marketValue, unrealizedPnL, returnRate }
        }).sort((a, b) => b.marketValue - a.marketValue))
    }

    const handleSaveGroup = async (code: string, group: string) => {
        const updated = { ...stockGroups, [code]: group }
        if (!group) delete updated[code]
        setStockGroups(updated)
        setGroupSaving(true)
        try {
            await setDoc(userDocNested(investDB, 'settings', 'stockGroups'), updated)
        } catch (err) { console.error(err) }
        setGroupSaving(false)
    }

    useEffect(() => { load() }, [])

    const totalMarketValue = holdings.reduce((s, h) => s + h.marketValue, 0)
    const totalCost = holdings.reduce((s, h) => s + h.totalCost, 0)
    const totalPnL = holdings.reduce((s, h) => s + h.unrealizedPnL, 0)
    const totalReturn = totalCost > 0 ? (totalPnL / totalCost) * 100 : 0
    const hasPrice = holdings.some(h => h.currentPrice !== null)
    const pnlColor = (v: number) => v >= 0 ? 'var(--c-positive)' : 'var(--c-danger)'
    const card: React.CSSProperties = { backgroundColor: 'var(--c-sidebar)', border: '1px solid var(--c-border)', borderRadius: '12px', padding: '20px' }
    const allGroups = Array.from(new Set(Object.values(stockGroups).filter(Boolean)))

    return (
        <>
            <style>{`
        .holdings-stats { display: grid; gap: 16px; grid-template-columns: repeat(4, 1fr); margin-bottom: 20px; }
        @media (max-width: 900px) { .holdings-stats { grid-template-columns: repeat(2, 1fr); } }
        @media (max-width: 480px) { .holdings-stats { grid-template-columns: 1fr; } }
        .table-wrap { overflow-x: auto; }
        .holdings-table { width: 100%; border-collapse: collapse; font-size: 14px; }
        .holdings-table th, .holdings-table td { padding: 12px 14px; text-align: left; white-space: nowrap; }
        .holdings-table th { color: var(--c-muted); font-weight: 500; border-bottom: 1px solid var(--c-border); font-size: 13px; }
        .holdings-table td { border-bottom: 1px solid var(--c-border); color: var(--c-text); }
        .holdings-table tr:hover td { background-color: rgba(79,142,247,0.04); }
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
      `}</style>

            <div style={{ padding: 'clamp(16px, 3vw, 32px)', maxWidth: '1600px', margin: '0 auto' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px', flexWrap: 'wrap', gap: '8px' }}>
                    <div>
                        <h1 style={{ fontSize: 'clamp(18px, 2.5vw, 22px)', fontWeight: 700, color: 'var(--c-text)', margin: 0 }}>股票持倉</h1>
                        <p style={{ fontSize: '13px', color: 'var(--c-muted)', margin: '4px 0 0' }}>
                            {lastUpdated ? `更新：${lastUpdated}` : '尚未更新現價，請點「更新現價」'}
                            {groupSaving && <span style={{ marginLeft: '8px', color: '#a78bfa' }}>· 族群儲存中...</span>}
                        </p>
                    </div>
                    <div style={{ display: 'flex', gap: '8px' }}>
                        <button onClick={load} disabled={loading} style={{ backgroundColor: 'var(--c-card)', border: '1px solid var(--c-border)', borderRadius: '8px', padding: '8px 14px', color: 'var(--c-text)', fontSize: '13px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px' }}>
                            <RefreshCw size={14} style={{ animation: loading ? 'spin 1s linear infinite' : 'none' }} />
                            {loading ? '載入中...' : '重新載入'}
                        </button>
                        <button onClick={handleUpdatePrices} disabled={priceLoading || loading} style={{ backgroundColor: 'var(--c-accent)', border: 'none', borderRadius: '8px', padding: '8px 14px', color: '#fff', fontSize: '13px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px' }}>
                            <RefreshCw size={14} style={{ animation: priceLoading ? 'spin 1s linear infinite' : 'none' }} />
                            {priceLoading ? '更新中...' : '更新現價'}
                        </button>
                    </div>
                </div>

                <div className="holdings-stats">
                    {[
                        { label: '持倉總市值', value: totalMarketValue, color: 'var(--c-accent)', fmt: (v: number) => `$${v.toLocaleString('zh-TW', { maximumFractionDigits: 0 })}` },
                        { label: '持倉總成本', value: totalCost, color: 'var(--c-muted)', fmt: (v: number) => `$${v.toLocaleString('zh-TW', { maximumFractionDigits: 0 })}` },
                        { label: '未實現損益', value: totalPnL, color: pnlColor(totalPnL), fmt: (v: number) => hasPrice ? `${v >= 0 ? '+' : ''}$${v.toLocaleString('zh-TW', { maximumFractionDigits: 0 })}` : '—' },
                        { label: '整體報酬率', value: totalReturn, color: pnlColor(totalReturn), fmt: (v: number) => hasPrice ? `${v >= 0 ? '+' : ''}${v.toFixed(2)}%` : '—' },
                    ].map(({ label, value, color, fmt }) => (
                        <div key={label} style={card}>
                            <div style={{ fontSize: '12px', color: 'var(--c-muted)', marginBottom: '8px' }}>{label}</div>
                            <div style={{ fontSize: 'clamp(16px, 2vw, 22px)', fontWeight: 700, color, display: 'flex', alignItems: 'center', gap: '6px' }}>
                                {fmt(value)}
                                {label === '未實現損益' && hasPrice && (value >= 0 ? <TrendingUp size={16} /> : <TrendingDown size={16} />)}
                            </div>
                        </div>
                    ))}
                </div>

                <div style={card}>
                    {loading ? (
                        <div style={{ textAlign: 'center', padding: '48px', color: 'var(--c-muted)' }}>載入中...</div>
                    ) : holdings.length === 0 ? (
                        <div style={{ textAlign: 'center', padding: '48px', color: 'var(--c-muted)' }}>
                            <p style={{ fontSize: '15px' }}>目前沒有持倉</p>
                            <p style={{ fontSize: '13px', marginTop: '8px' }}>請先在買賣紀錄新增買入交易</p>
                        </div>
                    ) : (
                        <div className="table-wrap">
                            <table className="holdings-table">
                                <thead>
                                    <tr>
                                        {['代號', '名稱', '股數', '均價（含手續費）', '現價', '成本', '市值', '未實現損益', '報酬率', '族群'].map(h => (
                                            <th key={h} style={h === '族群' ? { color: '#a78bfa' } : {}}>{h}</th>
                                        ))}
                                    </tr>
                                </thead>
                                <tbody>
                                    {holdings.map(h => (
                                        <tr key={h.code}>
                                            <td style={{ color: 'var(--c-accent)', fontWeight: 700 }}>{h.code}</td>
                                            <td>
                                                {h.name}
                                                {/* ✅ 融資標籤 */}
                                                {h.marginAmount > 0 && (
                                                    <span style={{ marginLeft: '6px', fontSize: '10px', color: 'var(--c-warning)', backgroundColor: 'rgba(245,166,35,0.12)', padding: '1px 5px', borderRadius: '4px', fontWeight: 600 }}>
                                                        融資
                                                    </span>
                                                )}
                                            </td>
                                            <td>{h.shares.toLocaleString()}</td>
                                            <td>{h.avgCost.toFixed(2)}</td>
                                            <td style={{ color: h.currentPrice === null ? 'var(--c-muted)' : h.currentPrice > h.avgCost ? 'var(--c-positive)' : 'var(--c-danger)', fontWeight: 600 }}>
                                                {h.currentPrice === null ? '—' : h.currentPrice.toFixed(2)}
                                            </td>
                                            <td>{h.totalCost.toLocaleString('zh-TW', { maximumFractionDigits: 0 })}</td>
                                            <td style={{ color: 'var(--c-accent)' }}>{h.marketValue.toLocaleString('zh-TW', { maximumFractionDigits: 0 })}</td>
                                            <td>
                                                <span style={{ color: h.currentPrice === null ? 'var(--c-muted)' : pnlColor(h.unrealizedPnL), fontWeight: 600 }}>
                                                    {h.currentPrice === null ? '—' : `${h.unrealizedPnL >= 0 ? '+' : ''}${h.unrealizedPnL.toLocaleString('zh-TW', { maximumFractionDigits: 0 })}`}
                                                </span>
                                            </td>
                                            <td>
                                                {h.currentPrice === null ? (
                                                    <span style={{ color: 'var(--c-muted)', fontSize: '12px' }}>請更新現價</span>
                                                ) : (
                                                    <span style={{ backgroundColor: h.returnRate >= 0 ? 'color-mix(in srgb, var(--c-positive) 12%, transparent)' : 'color-mix(in srgb, var(--c-danger) 12%, transparent)', color: pnlColor(h.returnRate), padding: '3px 10px', borderRadius: '20px', fontSize: '13px', fontWeight: 600 }}
                                                        title={h.marginAmount > 0 ? `融資損益率（以自備款 $${(h.totalCost - h.marginAmount).toLocaleString()} 為基準）` : '現股損益率'}
                                                    >
                                                        {h.returnRate >= 0 ? '+' : ''}{h.returnRate.toFixed(2)}%
                                                    </span>
                                                )}
                                            </td>
                                            <td>
                                                <GroupCell code={h.code} group={stockGroups[h.code] || ''} allGroups={allGroups} onSave={handleSaveGroup} />
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