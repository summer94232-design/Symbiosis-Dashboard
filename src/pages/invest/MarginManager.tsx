import LoadingState from '../../components/LoadingState'
import { useState, useEffect } from 'react'
import DisclosureNote from '../../components/DisclosureNote'
import { simulateMarginBuy, calcMarginStress } from '../../lib/calc'
import { loadPortfolioSnapshot } from '../../lib/portfolioSnapshot'
import { useInvestSync } from '../../InvestSyncContext'
import { usePrices } from '../../PriceContext'
import { TrendingDown, Plus, Trash2, Calculator, AlertTriangle, Flame } from 'lucide-react'
import { DEFAULT_MARGIN_RULES, loadMarginRules } from '../../lib/marginSettings'
import MarginRulesPanel from '../../components/MarginRulesPanel'

const card: React.CSSProperties = {
    backgroundColor: 'var(--c-card)', border: '1px solid var(--c-border)', borderRadius: '12px', padding: 'var(--ui-card-padding, 20px)'
}

interface MarginPosition {
    code: string
    name: string
    shares: number
    marginAmount: number
    marginCost: number
    currentPrice: number | null
}

interface SimRow {
    id: number
    code: string
    price: string
    shares: string
    ratio: string
}

export default function MarginManager() {
    const { version: syncVersion } = useInvestSync()
    const { prices } = usePrices()
    const [storedPositions, setPositions] = useState<MarginPosition[]>([])
    const positions = storedPositions.map(position => Object.hasOwn(prices, position.code)
        ? { ...position, currentPrice: prices[position.code] } : position)
    const [loading, setLoading] = useState(true)
    const [hasLoaded, setHasLoaded] = useState(false)
    const [marginRules, setMarginRules] = useState(DEFAULT_MARGIN_RULES)
    const ratioColor = (v: number) => v >= marginRules.safeRatio ? 'var(--c-positive)' : v >= marginRules.maintenanceRatio ? 'var(--c-warning)' : 'var(--c-danger)'
    const ratioLabel = (v: number) => v >= marginRules.safeRatio ? '✓ 安全' : v >= marginRules.maintenanceRatio ? '⚠ 留意' : '⚠ 危險'

    useEffect(() => { void loadMarginRules().then(setMarginRules) }, [])

    // 試算列（支援多筆同時試算）
    const [simRows, setSimRows] = useState<SimRow[]>([
        { id: 1, code: '', price: '', shares: '', ratio: '0.6' }
    ])

    // 壓力測試自訂跌幅（%）
    const [customDrop, setCustomDrop] = useState(10)

    // ── 載入融資部位 ─────────────────────────────────────────────────────────
    useEffect(() => {
        const load = async () => {
            setLoading(true)
            try {
                const snapshot = await loadPortfolioSnapshot()

                // ✅ 借款彙總一律走 calc.ts 的 aggregateMarginPositions（唯一真實來源），
                //    與 Dashboard / 資產趨勢同口徑：
                //    - 借款金額用 calcMarginDebt 重算（捨去至千元），不採信舊資料可能殘留的 marginAmount 欄位
                //    - 歸還比例 = 賣出股數 / 融資股數
                //    - 賣超／全數出清時借款自動歸零，不會出現負值或負無窮維持率
                //    - shares > 0 且 marginAmount > 0 的過濾已在 calc.ts 內完成
                const active: MarginPosition[] = snapshot.marginPositions.map(m => {
                    const raw = snapshot.prices[m.code]
                    return { ...m, currentPrice: typeof raw === 'number' && raw > 0 ? raw : null }
                })
                setPositions(active)
            setHasLoaded(true)
            } catch (err) { console.error(err) }
            finally { setLoading(false) }
        }
        void load()
    }, [syncVersion])

    // ── 整戶維持率計算（現況）────────────────────────────────────────────────
    const totalDebt = positions.reduce((s, m) => s + m.marginAmount, 0)
    const totalMV = positions.reduce((s, m) => {
        const mv = m.currentPrice !== null ? m.currentPrice * m.shares : m.marginCost
        return s + mv
    }, 0)
    const currentRatio = totalDebt > 0 ? (totalMV / totalDebt) * 100 : null
    const hasPrice = positions.some(m => m.currentPrice !== null)

    // ── 壓力測試：整戶臨界跌幅 + 各檔單獨觸線跌幅（calc.ts 純函式，沿用上方 positions）──
    const stress = calcMarginStress(
        positions.map(m => ({
            code: m.code, name: m.name,
            marketValue: m.currentPrice !== null ? m.currentPrice * m.shares : m.marginCost,
        })),
        totalDebt,
        [0.05, 0.10, 0.15, 0.20, 0.25],
        marginRules,
    )
    const dropByCode: Record<string, number | null> = Object.fromEntries(stress.perStock.map(p => [p.code, p.dropTo130]))
    const riskiestCode = stress.perStock
        .filter(p => p.dropTo130 !== null)
        .sort((a, b) => (a.dropTo130! - b.dropTo130!))[0]?.code ?? null
    const customRatio = currentRatio !== null ? currentRatio * (1 - customDrop / 100) : null

    // ── 試算邏輯（多筆加總）──────────────────────────────────────────────────
    const validRows = simRows.filter(r => {
        const p = parseFloat(r.price), s = parseInt(r.shares, 10), ratio = parseFloat(r.ratio)
        return p > 0 && s > 0 && ratio > 0 && ratio <= 1
    })

    // 多筆試算：逐筆累加
    let accMV = totalMV
    let accDebt = totalDebt
    const rowResults = simRows.map(r => {
        const p = parseFloat(r.price), s = parseInt(r.shares, 10), ratio = parseFloat(r.ratio)
        if (!(p > 0 && s > 0 && ratio > 0 && ratio <= 1)) return null
        const res = simulateMarginBuy(accMV, accDebt, p, s, ratio, marginRules)
        accMV = res.newMarketValue
        accDebt = res.newDebt
        return res
    })

    const finalRatio = validRows.length > 0 && accDebt > 0 ? (accMV / accDebt) * 100 : null
    const totalAddedDebt = rowResults.reduce((s, r) => s + (r?.addedDebt ?? 0), 0)
    const totalAddedEquity = rowResults.reduce((s, r) => s + (r?.addedEquity ?? 0), 0)

    // ── 試算列操作 ────────────────────────────────────────────────────────────
    const updateRow = (id: number, field: keyof SimRow, value: string) => {
        setSimRows(prev => prev.map(r => r.id === id ? { ...r, [field]: value } : r))
    }
    const addRow = () => {
        setSimRows(prev => [...prev, { id: Date.now(), code: '', price: '', shares: '', ratio: '0.6' }])
    }
    const removeRow = (id: number) => {
        setSimRows(prev => prev.length > 1 ? prev.filter(r => r.id !== id) : prev)
    }
    const clearAll = () => {
        setSimRows([{ id: Date.now(), code: '', price: '', shares: '', ratio: '0.6' }])
    }

    return (
        <>
            <style>{`
        .mm-grid { display: grid; gap: 16px; grid-template-columns: repeat(2, minmax(0, 1fr)); }
        @media (max-width: 800px) { .mm-grid { grid-template-columns: minmax(0, 1fr); } }
        .mm-table { width: 100%; border-collapse: collapse; font-size: 13px; }
        .mm-table th { padding: 8px 10px; text-align: left; color: var(--c-muted); font-weight: 500; border-bottom: 1px solid var(--c-border); white-space: nowrap; }
        .mm-table td { padding: 10px; border-bottom: 1px solid var(--c-border); color: var(--c-text); white-space: nowrap; }
        .sim-input { width: 90px; padding: 6px 8px; background: var(--c-bg); border: 1px solid var(--c-border); border-radius: 6px; color: var(--c-text); font-size: 13px; outline: none; }
        .sim-input:focus { border-color: var(--c-accent); }
        .mm-sim-fields { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 6px; }
        .mm-sim-field { display: grid; gap: 4px; min-width: 0; font-size: 11px; color: var(--c-muted); }
        .mm-sim-field .sim-input { width: 100%; min-width: 0; }
        .mm-sim-footer { display: flex; align-items: center; justify-content: flex-end; gap: 8px; min-height: 28px; }
        .mm-sim-row + .mm-sim-row { padding-top: 8px; border-top: 1px solid var(--c-border); }
        @media (max-width: 480px) { .mm-sim-fields { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
      `}</style>

            <div style={{ padding: 'var(--ui-page-padding, clamp(16px, 3vw, 32px))', maxWidth: '1200px', margin: '0 auto' }}>
                <div style={{ marginBottom: '16px' }}>
                    <h1 style={{ fontSize: 'clamp(18px, 2.5vw, 22px)', fontWeight: 700, color: 'var(--c-text)', margin: 0 }}>融資管理</h1>
                    
                </div>

                <MarginRulesPanel rules={marginRules} onSaved={setMarginRules} />

                {loading && hasLoaded && <p className="ui-refresh-status" role="status">資料更新中…</p>}
                {loading && !hasLoaded ? (
                    <LoadingState />
                ) : (
                    <>
                        {/* ── 整戶維持率總覽 ── */}
                        <div style={{
                            ...card,
                            marginBottom: '16px',
                            borderColor: currentRatio !== null && currentRatio < marginRules.maintenanceRatio
                                ? 'color-mix(in srgb, var(--c-danger) 50%, transparent)'
                                : currentRatio !== null && currentRatio < marginRules.safeRatio
                                    ? 'color-mix(in srgb, var(--c-warning) 40%, transparent)'
                                    : 'var(--c-border)',
                            background: currentRatio !== null && currentRatio < marginRules.maintenanceRatio
                                ? 'linear-gradient(135deg, var(--c-card) 0%, color-mix(in srgb, var(--c-danger) 6%, transparent) 100%)'
                                : currentRatio !== null && currentRatio < marginRules.safeRatio
                                    ? 'linear-gradient(135deg, var(--c-card) 0%, color-mix(in srgb, var(--c-warning) 5%, transparent) 100%)'
                                    : 'var(--c-card)'
                        }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '16px' }}>
                                <div style={{ width: '40px', height: '40px', borderRadius: '10px', backgroundColor: `color-mix(in srgb, ${currentRatio ? ratioColor(currentRatio) : 'var(--c-muted)'} 12%, transparent)`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                                    <TrendingDown size={20} color={currentRatio ? ratioColor(currentRatio) : 'var(--c-muted)'} />
                                </div>
                                <div>
                                    <div style={{ fontSize: '12px', color: 'var(--c-muted)' }}>整戶融資維持率（現況）</div>
                                    <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px', marginTop: '2px' }}>
                                        <span style={{ fontSize: '28px', fontWeight: 700, color: currentRatio ? ratioColor(currentRatio) : 'var(--c-muted)' }}>
                                            {currentRatio !== null ? `${currentRatio.toFixed(1)}%` : positions.length === 0 ? '無融資部位' : '—'}
                                        </span>
                                        {currentRatio !== null && (
                                            <span style={{ fontSize: '12px', fontWeight: 600, padding: '2px 10px', borderRadius: '20px', backgroundColor: `color-mix(in srgb, ${ratioColor(currentRatio)} 12%, transparent)`, color: ratioColor(currentRatio) }}>
                                                {ratioLabel(currentRatio)}
                                            </span>
                                        )}
                                    </div>
                                    <div style={{ fontSize: '11px', color: 'var(--c-muted)', marginTop: '2px' }}>
                                        {!hasPrice ? '尚未更新現價，以買入成本估算' : '以最新現價計算'}
                                    </div>
                                </div>
                            </div>

                            {/* 三欄數字 */}
                            {positions.length > 0 && (
                                <div style={{ display: 'flex', gap: '24px', flexWrap: 'wrap', marginBottom: '16px' }}>
                                    <div>
                                        <div style={{ fontSize: '11px', color: 'var(--c-muted)', marginBottom: '4px' }}>融資股票市值</div>
                                        <div style={{ fontSize: '15px', fontWeight: 600, color: 'var(--c-text)' }}>${totalMV.toLocaleString('zh-TW', { maximumFractionDigits: 0 })}</div>
                                    </div>
                                    <div>
                                        <div style={{ fontSize: '11px', color: 'var(--c-muted)', marginBottom: '4px' }}>融資借款合計</div>
                                        <div style={{ fontSize: '15px', fontWeight: 600, color: 'var(--c-warning)' }}>${totalDebt.toLocaleString('zh-TW', { maximumFractionDigits: 0 })}</div>
                                    </div>
                                    <div>
                                        <div style={{ fontSize: '11px', color: 'var(--c-muted)', marginBottom: '4px' }}>融資部位數</div>
                                        <div style={{ fontSize: '15px', fontWeight: 600, color: '#a78bfa' }}>{positions.length} 檔</div>
                                    </div>
                                    {currentRatio !== null && (
                                        <>
                                            <div>
                                                <div style={{ fontSize: '11px', color: 'var(--c-muted)', marginBottom: '4px' }}>距追繳線({marginRules.maintenanceRatio}%)緩衝</div>
                                                <div style={{ fontSize: '15px', fontWeight: 600, color: totalMV - totalDebt * 1.30 >= 0 ? 'var(--c-positive)' : 'var(--c-danger)' }}>
                                                    ${(totalMV - totalDebt * 1.30).toLocaleString('zh-TW', { maximumFractionDigits: 0 })}
                                                </div>
                                            </div>
                                            <div>
                                                <div style={{ fontSize: '11px', color: 'var(--c-muted)', marginBottom: '4px' }}>距斷頭線({marginRules.liquidationRatio}%)緩衝</div>
                                                <div style={{ fontSize: '15px', fontWeight: 600, color: totalMV - totalDebt * 1.20 >= 0 ? 'var(--c-positive)' : 'var(--c-danger)' }}>
                                                    ${(totalMV - totalDebt * 1.20).toLocaleString('zh-TW', { maximumFractionDigits: 0 })}
                                                </div>
                                            </div>
                                        </>
                                    )}
                                </div>
                            )}

                            {/* 進度條 */}
                            {currentRatio !== null && (
                                <div>
                                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '10px', color: 'var(--c-muted)', marginBottom: '4px' }}>
                                        <span>斷頭線 {marginRules.liquidationRatio}%</span><span>追繳線 {marginRules.maintenanceRatio}%</span><span>安全線 {marginRules.safeRatio}%</span><span>目前 {currentRatio.toFixed(1)}%</span>
                                    </div>
                                    <div style={{ height: '6px', backgroundColor: 'var(--c-bg)', borderRadius: '3px', overflow: 'hidden', position: 'relative' }}>
                                        <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(to right, color-mix(in srgb, var(--c-danger) 30%, transparent) 0%, color-mix(in srgb, var(--c-danger) 30%, transparent) 20%, color-mix(in srgb, var(--c-warning) 30%, transparent) 20%, color-mix(in srgb, var(--c-warning) 30%, transparent) 40%, color-mix(in srgb, var(--c-positive) 20%, transparent) 40%, color-mix(in srgb, var(--c-positive) 20%, transparent) 100%)' }} />
                                        <div style={{ position: 'absolute', left: 0, top: 0, height: '100%', width: `${Math.min(currentRatio / 250 * 100, 100)}%`, backgroundColor: ratioColor(currentRatio), borderRadius: '3px', transition: 'width 0.4s ease' }} />
                                    </div>
                                </div>
                            )}

                            {currentRatio !== null && stress.dropTo130 !== null && stress.dropTo130 > 0 && (
                                <div style={{ marginTop: '12px', display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', padding: '9px 12px', backgroundColor: 'color-mix(in srgb, var(--c-warning) 8%, transparent)', border: '1px solid color-mix(in srgb, var(--c-warning) 25%, transparent)', borderRadius: '8px', fontSize: '13px', color: 'var(--c-warning)' }}>
                                    <AlertTriangle size={15} style={{ flexShrink: 0 }} />
                                    <span>持股整體再跌 <strong style={{ fontWeight: 700 }}>{(stress.dropTo130 * 100).toFixed(1)}%</strong> 觸及追繳線{stress.dropTo120 !== null && stress.dropTo120 > 0 && <> · 再跌 <strong style={{ fontWeight: 700 }}>{(stress.dropTo120 * 100).toFixed(1)}%</strong> 觸及斷頭</>}</span>
                                </div>
                            )}

                            {currentRatio !== null && currentRatio < marginRules.maintenanceRatio && (
                                <div style={{ marginTop: '12px', padding: '8px 12px', backgroundColor: 'color-mix(in srgb, var(--c-danger) 8%, transparent)', border: '1px solid color-mix(in srgb, var(--c-danger) 25%, transparent)', borderRadius: '8px', fontSize: '12px', color: 'var(--c-danger)' }}>
                                    ⚠️ 維持率低於 {marginRules.maintenanceRatio}%，請留意追繳風險！斷頭線為 {marginRules.liquidationRatio}%。
                                </div>
                            )}
                        </div>

                        {/* ── 兩欄：個股明細 + 試算 ── */}
                        <div className="mm-grid">
                            {/* 個股明細 */}
                            <div style={card}>
                                <div style={{ fontSize: '14px', fontWeight: 600, color: 'var(--c-text)', marginBottom: '16px' }}>融資個股明細</div>
                                {positions.length === 0 ? (
                                    <div style={{ textAlign: 'center', padding: '40px', color: 'var(--c-muted)', fontSize: '13px' }}>目前無融資部位</div>
                                ) : (
                                    <div style={{ overflowX: 'auto' }}>
                                        <table className="mm-table">
                                            <thead>
                                                <tr>
                                                    <th>代號</th><th>股數</th><th>市值</th><th>借款</th><th>個別維持率</th><th>單檔觸追繳</th>
                                                </tr>
                                            </thead>
                                            <tbody>
                                                {positions.map(m => {
                                                    const mv = m.currentPrice !== null ? m.currentPrice * m.shares : m.marginCost
                                                    const r = m.marginAmount > 0 ? (mv / m.marginAmount) * 100 : 0
                                                    return (
                                                        <tr key={m.code}>
                                                            <td>
                                                                <div style={{ fontWeight: 700, color: 'var(--c-accent)' }}>{m.code}</div>
                                                                <div style={{ fontSize: '11px', color: 'var(--c-muted)' }}>{m.name}</div>
                                                            </td>
                                                            <td>{m.shares.toLocaleString()}</td>
                                                            <td>${mv.toLocaleString('zh-TW', { maximumFractionDigits: 0 })}</td>
                                                            <td style={{ color: 'var(--c-warning)' }}>${m.marginAmount.toLocaleString('zh-TW', { maximumFractionDigits: 0 })}</td>
                                                            <td>
                                                                <span style={{ color: ratioColor(r), fontWeight: 700 }}>{r.toFixed(0)}%</span>
                                                                <span style={{ fontSize: '11px', marginLeft: '4px', color: ratioColor(r) }}>{ratioLabel(r)}</span>
                                                            </td>
                                                            <td>
                                                                {(() => {
                                                                    const d = dropByCode[m.code]
                                                                    const danger = m.code === riskiestCode
                                                                    if (d === null || d === undefined) return <span style={{ color: 'var(--c-positive)', fontWeight: 600 }}>單檔安全</span>
                                                                    if (d <= 0) return <span style={{ color: 'var(--c-danger)', fontWeight: 700 }}>已觸追繳</span>
                                                                    return (
                                                                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', color: danger ? 'var(--c-danger)' : 'var(--c-warning)', fontWeight: 700 }}>
                                                                            {danger && <Flame size={12} />}−{(d * 100).toFixed(0)}%
                                                                        </span>
                                                                    )
                                                                })()}
                                                            </td>
                                                        </tr>
                                                    )
                                                })}
                                            </tbody>
                                        </table>
                                    </div>
                                )}
                            </div>

                            {/* 加碼試算 */}
                            <div style={card}>
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px', marginBottom: '12px' }}>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                        <Calculator size={15} color="var(--c-accent)" />
                                        <span style={{ fontSize: '14px', fontWeight: 600, color: 'var(--c-text)' }}>加碼試算</span>
                                    </div>
                                    <div style={{ display: 'flex', gap: '6px' }}>
                                        <button onClick={addRow} style={{ display: 'flex', alignItems: 'center', gap: '4px', padding: '5px 10px', backgroundColor: 'color-mix(in srgb, var(--c-accent) 12%, transparent)', border: '1px solid color-mix(in srgb, var(--c-accent) 30%, transparent)', borderRadius: '6px', color: 'var(--c-accent)', fontSize: '12px', cursor: 'pointer' }}>
                                            <Plus size={12} />新增一筆
                                        </button>
                                        <button onClick={clearAll} style={{ padding: '5px 10px', backgroundColor: 'var(--c-card)', border: '1px solid var(--c-border)', borderRadius: '6px', color: 'var(--c-muted)', fontSize: '12px', cursor: 'pointer' }}>清除</button>
                                    </div>
                                </div>

                                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '16px' }}>
                                    {simRows.map((row, idx) => (
                                        <div className="mm-sim-row" key={row.id}>
                                            <div className="mm-sim-fields">
                                                <label className="mm-sim-field">代號<input className="sim-input" placeholder="代號" value={row.code} onChange={e => updateRow(row.id, 'code', e.target.value)} /></label>
                                                <label className="mm-sim-field">買入價<input className="sim-input" type="number" placeholder="價格" value={row.price} onChange={e => updateRow(row.id, 'price', e.target.value)} /></label>
                                                <label className="mm-sim-field">股數<input className="sim-input" type="number" placeholder="股數" value={row.shares} onChange={e => updateRow(row.id, 'shares', e.target.value)} /></label>
                                                <label className="mm-sim-field">融資成數<input className="sim-input" type="number" placeholder="0.6" value={row.ratio} onChange={e => updateRow(row.id, 'ratio', e.target.value)} /></label>
                                            </div>
                                            {(rowResults[idx] || simRows.length > 1) && <div className="mm-sim-footer">
                                                {rowResults[idx] && (
                                                <span style={{ fontSize: '13px', fontWeight: 700, color: ratioColor(rowResults[idx]!.newMarginRatio), minWidth: '55px' }}>
                                                    {rowResults[idx]!.newMarginRatio.toFixed(1)}%
                                                </span>
                                                )}
                                                {simRows.length > 1 && (
                                                <button aria-label={`移除第 ${idx + 1} 筆試算`} onClick={() => removeRow(row.id)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--c-danger)', padding: '2px' }}>
                                                    <Trash2 size={13} />
                                                </button>
                                                )}
                                            </div>}
                                        </div>
                                    ))}
                                </div>

                                {/* 試算結果總覽 */}
                                {finalRatio !== null ? (
                                    <div style={{ backgroundColor: 'var(--c-bg)', borderRadius: '10px', padding: '14px 16px', border: `1px solid color-mix(in srgb, ${ratioColor(finalRatio)} 28%, transparent)` }}>
                                        <div style={{ fontSize: '12px', color: 'var(--c-muted)', marginBottom: '10px' }}>加碼後整戶結果</div>
                                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
                                            <div>
                                                <div style={{ fontSize: '11px', color: 'var(--c-muted)', marginBottom: '2px' }}>加碼後維持率</div>
                                                <div style={{ fontSize: '22px', fontWeight: 700, color: ratioColor(finalRatio) }}>{finalRatio.toFixed(1)}%</div>
                                                <div style={{ fontSize: '11px', color: ratioColor(finalRatio), fontWeight: 600 }}>{ratioLabel(finalRatio)}</div>
                                            </div>
                                            <div>
                                                <div style={{ fontSize: '11px', color: 'var(--c-muted)', marginBottom: '2px' }}>較現在變化</div>
                                                <div style={{ fontSize: '18px', fontWeight: 700, color: finalRatio >= (currentRatio ?? 0) ? 'var(--c-positive)' : 'var(--c-danger)' }}>
                                                    {finalRatio >= (currentRatio ?? 0) ? '+' : ''}{(finalRatio - (currentRatio ?? 0)).toFixed(1)}%
                                                </div>
                                            </div>
                                            <div>
                                                <div style={{ fontSize: '11px', color: 'var(--c-muted)', marginBottom: '2px' }}>合計新增借款</div>
                                                <div style={{ fontSize: '14px', fontWeight: 600, color: 'var(--c-warning)' }}>${totalAddedDebt.toLocaleString('zh-TW', { maximumFractionDigits: 0 })}</div>
                                            </div>
                                            <div>
                                                <div style={{ fontSize: '11px', color: 'var(--c-muted)', marginBottom: '2px' }}>合計需自備款</div>
                                                <div style={{ fontSize: '14px', fontWeight: 600, color: 'var(--c-text)' }}>${totalAddedEquity.toLocaleString('zh-TW', { maximumFractionDigits: 0 })}</div>
                                            </div>
                                            <div>
                                                <div style={{ fontSize: '11px', color: 'var(--c-muted)', marginBottom: '2px' }}>距追繳線({marginRules.maintenanceRatio}%)緩衝</div>
                                                <div style={{ fontSize: '14px', fontWeight: 600, color: accMV - accDebt * 1.30 >= 0 ? 'var(--c-positive)' : 'var(--c-danger)' }}>
                                                    ${(accMV - accDebt * 1.30).toLocaleString('zh-TW', { maximumFractionDigits: 0 })}
                                                </div>
                                            </div>
                                            <div>
                                                <div style={{ fontSize: '11px', color: 'var(--c-muted)', marginBottom: '2px' }}>距斷頭線({marginRules.liquidationRatio}%)緩衝</div>
                                                <div style={{ fontSize: '14px', fontWeight: 600, color: accMV - accDebt * 1.20 >= 0 ? 'var(--c-positive)' : 'var(--c-danger)' }}>
                                                    ${(accMV - accDebt * 1.20).toLocaleString('zh-TW', { maximumFractionDigits: 0 })}
                                                </div>
                                            </div>
                                        </div>

                                        {/* 試算後進度條 */}
                                        <div style={{ marginTop: '12px' }}>
                                            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '10px', color: 'var(--c-muted)', marginBottom: '4px' }}>
                                                <span>斷頭 {marginRules.liquidationRatio}%</span><span>追繳 {marginRules.maintenanceRatio}%</span><span>安全 {marginRules.safeRatio}%</span><span>試算後 {finalRatio.toFixed(1)}%</span>
                                            </div>
                                            <div style={{ height: '6px', backgroundColor: 'var(--c-card)', borderRadius: '3px', overflow: 'hidden', position: 'relative' }}>
                                                <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(to right, color-mix(in srgb, var(--c-danger) 30%, transparent) 0%, color-mix(in srgb, var(--c-danger) 30%, transparent) 20%, color-mix(in srgb, var(--c-warning) 30%, transparent) 20%, color-mix(in srgb, var(--c-warning) 30%, transparent) 40%, color-mix(in srgb, var(--c-positive) 20%, transparent) 40%, color-mix(in srgb, var(--c-positive) 20%, transparent) 100%)' }} />
                                                {currentRatio !== null && (
                                                    <div style={{ position: 'absolute', left: 0, top: 0, height: '100%', width: `${Math.min(currentRatio / 250 * 100, 100)}%`, backgroundColor: `color-mix(in srgb, ${ratioColor(currentRatio)} 50%, transparent)`, borderRadius: '3px' }} />
                                                )}
                                                <div style={{ position: 'absolute', left: 0, top: 0, height: '100%', width: `${Math.min(finalRatio / 250 * 100, 100)}%`, backgroundColor: ratioColor(finalRatio), borderRadius: '3px', transition: 'width 0.4s ease' }} />
                                            </div>
                                            {currentRatio !== null && (
                                                <div style={{ fontSize: '10px', color: 'var(--c-muted)', marginTop: '4px' }}>淡色：現況 {currentRatio.toFixed(1)}% · 亮色：試算後</div>
                                            )}
                                        </div>
                                    </div>
                                ) : (
                                    <div style={{ textAlign: 'center', padding: '32px', color: 'var(--c-muted)', fontSize: '13px', opacity: 0.5 }}>
                                        輸入買入價格與股數後<br />自動計算加碼後維持率
                                    </div>
                                )}

                                <div style={{ marginTop: '14px', padding: '10px 12px', backgroundColor: 'color-mix(in srgb, var(--c-accent) 6%, transparent)', borderRadius: '8px', fontSize: '11px', color: 'var(--c-muted)', lineHeight: 1.6 }}>
                                    多筆累計試算，預設融資六成。
                                </div>
                            </div>
                        </div>

                        {/* ── 整體下跌壓力測試 ── */}
                        {positions.length > 0 && currentRatio !== null && (
                            <div style={{ ...card, marginTop: '16px' }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
                                    <AlertTriangle size={15} color="var(--c-warning)" />
                                    <span style={{ fontSize: '14px', fontWeight: 600, color: 'var(--c-text)' }}>整體下跌壓力測試</span>
                                </div>
                                <DisclosureNote summary="假設全部融資持股同幅下跌。" style={{ margin: '0 0 12px' }}>查看維持率與追繳線的距離；單一個股暴跌的觸線點見上方明細的「單檔觸追繳」。</DisclosureNote>

                                <div className="mm-grid">
                                    {/* 固定情境表 */}
                                    <div style={{ backgroundColor: 'var(--c-bg)', borderRadius: '10px', padding: '12px 16px' }}>
                                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1.4fr', gap: '6px 12px', fontSize: '11px', color: 'var(--c-muted)' }}>
                                            <span>整體跌幅</span><span style={{ textAlign: 'right' }}>維持率</span><span style={{ textAlign: 'right' }}>距追繳線(pp)</span>
                                        </div>
                                        <div style={{ height: '1px', backgroundColor: 'var(--c-border)', margin: '8px 0' }} />
                                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1.4fr', gap: '10px 12px', fontSize: '14px', alignItems: 'center' }}>
                                            {stress.scenarios.map(s => (
                                                <div key={s.drop} style={{ display: 'contents' }}>
                                                    <span style={{ color: 'var(--c-text)' }}>−{(s.drop * 100).toFixed(0)}%</span>
                                                    <span style={{ textAlign: 'right', fontWeight: 700, color: ratioColor(s.ratio) }}>{s.ratio.toFixed(1)}%</span>
                                                    <span style={{ textAlign: 'right', color: s.gapTo130 >= 0 ? 'var(--c-muted)' : 'var(--c-danger)' }}>{s.gapTo130 >= 0 ? `尚有 ${s.gapTo130.toFixed(1)}` : `已破 ${Math.abs(s.gapTo130).toFixed(1)}`}</span>
                                                </div>
                                            ))}
                                        </div>
                                    </div>

                                    {/* 自訂跌幅滑桿 */}
                                    <div style={{ backgroundColor: 'var(--c-bg)', borderRadius: '10px', padding: '14px 16px', display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
                                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '12px', flexWrap: 'wrap', gap: '8px' }}>
                                            <span style={{ fontSize: '12px', color: 'var(--c-muted)' }}>自訂跌幅試算</span>
                                            <div style={{ display: 'flex', alignItems: 'baseline', gap: '10px' }}>
                                                <span style={{ fontSize: '13px', color: 'var(--c-text)' }}>跌 <strong style={{ fontWeight: 700 }}>{customDrop}%</strong> →</span>
                                                {customRatio !== null && <span style={{ fontSize: '22px', fontWeight: 700, color: ratioColor(customRatio) }}>{customRatio.toFixed(1)}%</span>}
                                                {customRatio !== null && <span style={{ fontSize: '12px', fontWeight: 600, color: ratioColor(customRatio) }}>{ratioLabel(customRatio)}</span>}
                                            </div>
                                        </div>
                                        <input type="range" min={0} max={40} step={1} value={customDrop} onChange={e => setCustomDrop(parseInt(e.target.value, 10))} style={{ width: '100%', accentColor: customRatio !== null ? ratioColor(customRatio) : 'var(--c-accent)' }} />
                                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: 'var(--c-muted)', marginTop: '4px' }}><span>0%</span><span>40%</span></div>
                                    </div>
                                </div>
                            </div>
                        )}
                    </>
                )}
            </div>
        </>
    )
}
