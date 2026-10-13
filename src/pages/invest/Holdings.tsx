import LoadingState from '../../components/LoadingState'
import { useState, useEffect, useRef } from 'react'
import { getDoc, setDoc } from 'firebase/firestore'
import { investDB } from '../../lib/firebase'
import { captureUserSession, userDocNested } from '../../lib/userDB'
import { loadPortfolioSnapshot } from '../../lib/portfolioSnapshot'
import InfoHint from '../../components/InfoHint'
import ActionNotice, { type ActionNoticeState } from '../../components/ActionNotice'
import { calcHoldingValuation } from '../../lib/calc'
// ✅ 1-2：共用 UI 樣式與損益顏色
import { card } from '../../ui/styles'
import { pnlColor } from '../../ui/format'
import { formatAutoSnapshotFeedback, type AutoSnapshotResult } from '../../lib/snapshot'
import { RefreshCw, TrendingUp, TrendingDown, Check, X, ChevronDown, ChevronUp } from 'lucide-react'
import { usePrices } from '../../PriceContext'
import { useInvestSync } from '../../InvestSyncContext'

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
        if (editing) inputRef.current?.focus()
    }, [editing])

    const handleSave = () => { onSave(code, value.trim()); setEditing(false) }
    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter') handleSave()
        if (e.key === 'Escape') setEditing(false)
    }

    if (!editing) {
        return (
            <button type="button" aria-label={`${code} 設定族群`} style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', cursor: 'pointer', border: 0, background: 'transparent', padding: 0 }} onClick={() => { setValue(group); setEditing(true) }} title="點擊編輯族群">
                {group ? (
                    <span style={{ fontSize: '12px', color: 'var(--c-purple)', backgroundColor: 'rgba(167,139,250,0.12)', padding: '2px 8px', borderRadius: '20px', fontWeight: 600 }}>
                        {group}
                    </span>
                ) : (
                    <span style={{ fontSize: '12px', color: 'var(--c-muted)' }}>+ 設定族群</span>
                )}
            </button>
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

export default function Holdings() {
    // ── 全域現價 Context ──
    const { prices, lastUpdated, priceLoading, updatePrices: ctxUpdatePrices, loadCachedPrices } = usePrices()
    const { version: syncVersion } = useInvestSync()

    const [storedHoldings, setHoldings] = useState<DisplayHolding[]>([])
    const holdings = storedHoldings.map(h => Object.hasOwn(prices, h.code) ? { ...h, ...calcHoldingValuation(h, prices[h.code]) } : h)
    const [loading, setLoading] = useState(true)
    const [hasLoaded, setHasLoaded] = useState(false)
    const [stockGroups, setStockGroups] = useState<Record<string, string>>({})
    const [groupSaving, setGroupSaving] = useState(false)
    const [expandedCode, setExpandedCode] = useState<string | null>(null)
    const [notice, setNotice] = useState<ActionNoticeState | null>(null)
    const priceRefreshGeneration = useRef(0)
    const noticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

    const showNotice = (next: ActionNoticeState) => {
        if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current)
        setNotice(next)
        noticeTimerRef.current = setTimeout(() => setNotice(null), 4200)
    }

    const load = async (showFeedback = false) => {
        setLoading(true)
        try {
            // ✅ 1-1：改走共用快取層（lib/investData）
            const snapshot = await loadPortfolioSnapshot(prices)
            loadCachedPrices(snapshot.savedPriceData, snapshot.priceUpdatedAt)

            const groupDoc = await getDoc(userDocNested(investDB, 'settings', 'stockGroups'))
            const groups: Record<string, string> = groupDoc.exists() ? groupDoc.data() : {}
            setStockGroups(groups)

            const list: DisplayHolding[] = snapshot.holdings.map(holding => ({
                code: holding.code, name: holding.name, shares: holding.shares,
                avgCost: holding.avgCost, currentPrice: holding.currentPrice,
                marketValue: holding.marketValue, totalCost: holding.totalCost,
                marginAmount: holding.marginAmount, unrealizedPnL: holding.unrealizedPnL,
                returnRate: holding.returnRate,
            }))

            setHoldings(list)
            setHasLoaded(true)
            if (showFeedback) showNotice({ type: 'success', message: '持倉資料已重新載入。' })
        } catch (err) {
            console.error(err)
            showNotice({ type: 'error', message: '持倉載入失敗，請確認網路後再試一次。' })
        }
        setLoading(false)
    }

    // ★ 更新現價：委託 Context，用回傳的 quotes 同步更新本頁 holdings
    const handleUpdatePrices = async () => {
        const generation = ++priceRefreshGeneration.current
        const session = captureUserSession()
        let symbols = holdings.map(h => h.code)
        let snapshotResult: AutoSnapshotResult | null = null
        let priceFeedback: ActionNoticeState | null = null
        const publishFeedback = () => {
            try { session.assertActive() } catch { return }
            if (!priceFeedback || priceRefreshGeneration.current !== generation) return
            const snapshotFeedback = snapshotResult ? formatAutoSnapshotFeedback(snapshotResult) : null
            showNotice({
                type: priceFeedback.type === 'error' || snapshotFeedback?.type === 'error' ? 'error'
                    : priceFeedback.type === 'info' || snapshotFeedback?.type === 'info' ? 'info' : 'success',
                message: [priceFeedback.message, snapshotFeedback?.message].filter(Boolean).join(' '),
            })
        }
        const quotes = await ctxUpdatePrices(symbols, {
            onSnapshot: result => { snapshotResult = result; publishFeedback() },
        })
        try { session.assertActive() } catch { return }
        symbols = Object.keys(quotes)
        const updatedCount = symbols.filter(code => typeof quotes[code] === 'number' && (quotes[code] as number) > 0).length
        priceFeedback = symbols.length === 0 || updatedCount === 0
            ? { type: 'error', message: '這次未取得有效現價，請查看報價提示後再試。' }
            : updatedCount < symbols.length
                ? { type: 'info', message: `已更新 ${updatedCount} 檔，另有 ${symbols.length - updatedCount} 檔暫時無報價。` }
                : { type: 'success', message: `已更新 ${updatedCount} 檔股票現價。` }
        publishFeedback()
        setHoldings(prev => prev.map(h => ({ ...h, ...calcHoldingValuation(h, quotes[h.code]) }))
            .sort((a, b) => b.marketValue - a.marketValue))
    }

    const handleSaveGroup = async (code: string, group: string) => {
        const previous = stockGroups
        const updated = { ...stockGroups, [code]: group }
        if (!group) delete updated[code]
        setStockGroups(updated)
        setGroupSaving(true)
        try {
            await setDoc(userDocNested(investDB, 'settings', 'stockGroups'), updated)
            showNotice({ type: 'success', message: `${code} 的族群已儲存。` })
        } catch (err) {
            console.error(err)
            setStockGroups(previous)
            showNotice({ type: 'error', message: '族群儲存失敗，已保留原本設定。' })
        }
        setGroupSaving(false)
    }

    useEffect(() => {
        void load()
        return () => {
            if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current)
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [syncVersion])

    const totalMarketValue = holdings.reduce((s, h) => s + h.marketValue, 0)
    const totalCost = holdings.reduce((s, h) => s + h.totalCost, 0)
    const totalPnL = holdings.reduce((s, h) => s + h.unrealizedPnL, 0)
    const totalReturn = totalCost > 0 ? (totalPnL / totalCost) * 100 : 0
    const hasPrice = holdings.some(h => h.currentPrice !== null)
    const pricedHoldings = holdings.filter(h => h.currentPrice !== null)
    const missingPriceHoldings = holdings.filter(h => h.currentPrice === null)
    const valuationCompleteness = holdings.length > 0 ? Math.round(pricedHoldings.length / holdings.length * 100) : 100
    const allGroups = Array.from(new Set(Object.values(stockGroups).filter(Boolean)))

    return (
        <>
            {notice && <ActionNotice {...notice} onClose={() => setNotice(null)} />}
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

            <div style={{ padding: 'var(--ui-page-padding, clamp(16px, 3vw, 32px))', maxWidth: '1600px', margin: '0 auto' }}>
                <div className="page-header">
                    <div className="page-heading">
                        <h1 className="page-title">股票持倉</h1>
                        <p className="page-subtitle">
                            {lastUpdated ? `更新：${lastUpdated}` : '尚未更新現價，請點「更新現價」'}
                            {groupSaving && <span style={{ marginLeft: '8px', color: 'var(--c-purple)' }}>· 族群儲存中...</span>}
                        </p>
                    </div>
                    <div className="page-actions">
                        <button className="ui-button ui-button-secondary" onClick={() => void load(true)} disabled={loading}>
                            <RefreshCw size={15} className={loading ? 'is-spinning' : undefined} />
                            {loading ? '載入中...' : '重新載入'}
                        </button>
                        <button className="ui-button ui-button-primary" onClick={() => void handleUpdatePrices()} disabled={priceLoading || loading}>
                            <RefreshCw size={15} className={priceLoading ? 'is-spinning' : undefined} />
                            {priceLoading ? '更新中...' : '更新現價'}
                        </button>
                    </div>
                </div>

                {holdings.length > 0 && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', marginBottom: '14px', padding: '8px 12px', borderRadius: '9px', border: `1px solid ${missingPriceHoldings.length ? 'color-mix(in srgb, var(--c-warning) 35%, transparent)' : 'color-mix(in srgb, var(--c-positive) 30%, transparent)'}`, background: missingPriceHoldings.length ? 'color-mix(in srgb, var(--c-warning) 7%, transparent)' : 'color-mix(in srgb, var(--c-positive) 6%, transparent)', color: missingPriceHoldings.length ? 'var(--c-warning)' : 'var(--c-positive)', fontSize: '12px' }}>
                        {missingPriceHoldings.length ? <X size={14} /> : <Check size={14} />}
                        <strong>估值完整度 {pricedHoldings.length}/{holdings.length}（{valuationCompleteness}%）</strong>
                        {missingPriceHoldings.length > 0 && <span style={{ color: 'var(--c-muted)' }}>缺價：{missingPriceHoldings.map(h => h.code).join('、')}；暫以成本估算市值</span>}
                    </div>
                )}

                <div className="holdings-stats">
                    {[
                        { label: '持倉總市值（含出借）', value: totalMarketValue, color: 'var(--c-accent)', fmt: (v: number) => `$${v.toLocaleString('zh-TW', { maximumFractionDigits: 0 })}` },
                        { label: '持倉總成本', value: totalCost, color: 'var(--c-muted)', fmt: (v: number) => `$${v.toLocaleString('zh-TW', { maximumFractionDigits: 0 })}` },
                        { label: '未實現損益', value: totalPnL, color: pnlColor(totalPnL), fmt: (v: number) => hasPrice ? `${v >= 0 ? '+' : ''}$${v.toLocaleString('zh-TW', { maximumFractionDigits: 0 })}` : '—' },
                        { label: '整體報酬率', value: totalReturn, color: pnlColor(totalReturn), fmt: (v: number) => hasPrice ? `${v >= 0 ? '+' : ''}${v.toFixed(2)}%` : '—' },
                    ].map(({ label, value, color, fmt }) => (
                        <div key={label} style={card}>
                            <div style={{ fontSize: '13px', color: 'var(--c-muted)', marginBottom: '8px', display: 'flex', alignItems: 'center' }}>
                                {label}
                                {label === '未實現損益' && <InfoHint text="市值扣含費成本及預估賣出費稅，不含股息；含出借股票。預估手續費未折扣；券商指定批次優先，其餘先進先出。融資未扣利息。" />}
                                {label === '整體報酬率' && <InfoHint text="整體：未實現損益 ÷ 全額成本；融資個股：以自備款計算。" />}
                            </div>
                            <div style={{ fontSize: 'clamp(16px, 2vw, 22px)', fontWeight: 700, color, display: 'flex', alignItems: 'center', gap: '6px' }}>
                                {fmt(value)}
                                {label === '未實現損益' && hasPrice && (value >= 0 ? <TrendingUp size={16} /> : <TrendingDown size={16} />)}
                            </div>
                        </div>
                    ))}
                </div>

                <div style={card}>
                    {loading && hasLoaded && <p className="ui-refresh-status" role="status">資料更新中…</p>}
                {loading && !hasLoaded ? (
                        <LoadingState />
                    ) : holdings.length === 0 ? (
                        <div style={{ textAlign: 'center', padding: '48px', color: 'var(--c-muted)' }}>
                            <p style={{ fontSize: '15px' }}>目前沒有持倉</p>
                            <p style={{ fontSize: '13px', marginTop: '8px' }}>請先在買賣紀錄新增買入交易</p>
                        </div>
                    ) : (
                        <>
                            <div className="mobile-holdings-list">
                                {holdings.map(h => {
                                    const expanded = expandedCode === h.code
                                    return (
                                        <div key={h.code} className="mobile-holding-card">
                                            <button type="button" className="mobile-holding-summary" onClick={() => setExpandedCode(expanded ? null : h.code)}>
                                                <span className="mobile-holding-identity">
                                                    <strong>{h.code}</strong>
                                                    <span>{h.name}</span>
                                                    {h.marginAmount > 0 && <em>融資</em>}
                                                </span>
                                                <span className="mobile-holding-result">
                                                    <strong>{h.marketValue.toLocaleString('zh-TW', { maximumFractionDigits: 0 })}</strong>
                                                    <span style={{ color: h.currentPrice === null ? 'var(--c-muted)' : pnlColor(h.returnRate) }}>
                                                        {h.currentPrice === null ? '請更新現價' : `${h.returnRate >= 0 ? '+' : ''}${h.returnRate.toFixed(2)}%`}
                                                    </span>
                                                </span>
                                                {expanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                                            </button>
                                            {expanded && (
                                                <div className="mobile-holding-details">
                                                    {[
                                                        ['股數', h.shares.toLocaleString()],
                                                        ['均價', h.avgCost.toFixed(2)],
                                                        ['現價', h.currentPrice === null ? '—' : h.currentPrice.toFixed(2)],
                                                        ['成本', h.totalCost.toLocaleString('zh-TW', { maximumFractionDigits: 0 })],
                                                        ['市值', h.marketValue.toLocaleString('zh-TW', { maximumFractionDigits: 0 })],
                                                        ['未實現損益', h.currentPrice === null ? '—' : `${h.unrealizedPnL >= 0 ? '+' : ''}${h.unrealizedPnL.toLocaleString('zh-TW', { maximumFractionDigits: 0 })}`],
                                                    ].map(([label, value]) => (
                                                        <div key={label}>
                                                            <span>{label}</span>
                                                            <strong>{value}</strong>
                                                        </div>
                                                    ))}
                                                    <div className="mobile-holding-group">
                                                        <span>族群</span>
                                                        <GroupCell code={h.code} group={stockGroups[h.code] || ''} allGroups={allGroups} onSave={handleSaveGroup} />
                                                    </div>
                                                </div>
                                            )}
                                        </div>
                                    )
                                })}
                            </div>
                            <div className="table-wrap desktop-holdings-table">
                                <table className="holdings-table">
                                <thead>
                                    <tr>
                                        {['代號', '名稱', '股數', '均價（含手續費）', '現價', '成本', '市值', '未實現損益', '報酬率', '族群'].map(h => (
                                            <th key={h} style={h === '族群' ? { color: 'var(--c-purple)' } : {}}>{h}</th>
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
                        </>
                    )}
                </div>
            </div>
        </>
    )
}
