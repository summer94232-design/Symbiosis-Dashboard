import { useState, useEffect } from 'react'
import { collection, getDocs, orderBy, query } from 'firebase/firestore'
import { investDB } from '../../lib/firebase'
import { userCol, userDocNested } from '../../lib/userDB'
import { getDoc } from 'firebase/firestore'
import { simulateMarginBuy, type TradeRecord } from '../../lib/calc'
import { TrendingDown, Plus, Trash2, Calculator } from 'lucide-react'

const card: React.CSSProperties = {
    backgroundColor: '#1a1d27', border: '1px solid #2e3349', borderRadius: '12px', padding: '20px'
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

const ratioColor = (v: number) =>
    v >= 160 ? '#00c896' : v >= 130 ? '#f5a623' : '#ff5757'

const ratioLabel = (v: number) =>
    v >= 160 ? '✓ 安全' : v >= 130 ? '⚠ 留意' : '⚠ 危險'

export default function MarginManager() {
    const [positions, setPositions] = useState<MarginPosition[]>([])
    const [loading, setLoading] = useState(true)

    // 試算列（支援多筆同時試算）
    const [simRows, setSimRows] = useState<SimRow[]>([
        { id: 1, code: '', price: '', shares: '', ratio: '0.6' }
    ])

    // ── 載入融資部位 ─────────────────────────────────────────────────────────
    useEffect(() => {
        const load = async () => {
            setLoading(true)
            try {
                const [tradesSnap, priceDoc] = await Promise.all([
                    getDocs(query(userCol(investDB, 'trades'), orderBy('date', 'asc'))),
                    getDoc(userDocNested(investDB, 'settings', 'lastPrices')),
                ])
                const trades = tradesSnap.docs.map(d => d.data() as TradeRecord)
                const savedPrices: Record<string, number | string> = priceDoc.exists() ? priceDoc.data() : {}

                const marginMap: Record<string, MarginPosition> = {}
                for (const t of trades) {
                    if (!t.isMargin) continue
                    if (!marginMap[t.code]) {
                        marginMap[t.code] = { code: t.code, name: t.name, shares: 0, marginAmount: 0, marginCost: 0, currentPrice: null }
                    }
                    const pos = marginMap[t.code]
                    if (t.type === 'buy') {
                        const stockVal = t.price * t.shares
                        const mAmt = (t as any).marginAmount ?? Math.floor(stockVal * ((t as any).marginRatio ?? 0.6))
                        pos.shares += t.shares
                        pos.marginAmount += mAmt
                        pos.marginCost += stockVal
                    } else if (t.type === 'sell' && pos.shares > 0) {
                        const ratio = t.shares / pos.shares
                        pos.marginAmount -= pos.marginAmount * ratio
                        pos.marginCost -= pos.marginCost * ratio
                        pos.shares -= t.shares
                    }
                }

                const active = Object.values(marginMap).filter(m => m.shares > 0 && m.marginAmount > 0)
                active.forEach(m => {
                    const raw = savedPrices[m.code]
                    m.currentPrice = typeof raw === 'number' && raw > 0 ? raw : null
                })
                setPositions(active)
            } catch (err) { console.error(err) }
            finally { setLoading(false) }
        }
        void load()
    }, [])

    // ── 整戶維持率計算（現況）────────────────────────────────────────────────
    const totalDebt = positions.reduce((s, m) => s + m.marginAmount, 0)
    const totalMV = positions.reduce((s, m) => {
        const mv = m.currentPrice !== null ? m.currentPrice * m.shares : m.marginCost
        return s + mv
    }, 0)
    const currentRatio = totalDebt > 0 ? (totalMV / totalDebt) * 100 : null
    const hasPrice = positions.some(m => m.currentPrice !== null)

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
        const res = simulateMarginBuy(accMV, accDebt, p, s, ratio)
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
        .mm-grid { display: grid; gap: 16px; grid-template-columns: 1fr 1fr; }
        @media (max-width: 800px) { .mm-grid { grid-template-columns: 1fr; } }
        .mm-table { width: 100%; border-collapse: collapse; font-size: 13px; }
        .mm-table th { padding: 8px 10px; text-align: left; color: #8892a4; font-weight: 500; border-bottom: 1px solid #2e3349; white-space: nowrap; }
        .mm-table td { padding: 10px; border-bottom: 1px solid #2e3349; color: #e2e8f0; white-space: nowrap; }
        .sim-input { width: 90px; padding: 6px 8px; background: #0f1117; border: 1px solid #2e3349; border-radius: 6px; color: #e2e8f0; font-size: 13px; outline: none; }
        .sim-input:focus { border-color: #4f8ef7; }
      `}</style>

            <div style={{ padding: 'clamp(16px, 3vw, 32px)', maxWidth: '1200px', margin: '0 auto' }}>
                <div style={{ marginBottom: '24px' }}>
                    <h1 style={{ fontSize: 'clamp(18px, 2.5vw, 22px)', fontWeight: 700, color: '#e2e8f0', margin: 0 }}>融資管理</h1>
                    <p style={{ fontSize: '12px', color: '#8892a4', margin: '4px 0 0' }}>整戶融資維持率監控 · 加碼試算</p>
                </div>

                {loading ? (
                    <div style={{ textAlign: 'center', padding: '80px', color: '#8892a4' }}>載入中...</div>
                ) : (
                    <>
                        {/* ── 整戶維持率總覽 ── */}
                        <div style={{
                            ...card,
                            marginBottom: '16px',
                            borderColor: currentRatio !== null && currentRatio < 130 ? 'rgba(255,87,87,0.5)'
                                : currentRatio !== null && currentRatio < 160 ? 'rgba(245,166,35,0.4)' : '#2e3349',
                            background: currentRatio !== null && currentRatio < 130 ? 'linear-gradient(135deg, #1a1d27 0%, rgba(255,87,87,0.06) 100%)'
                                : currentRatio !== null && currentRatio < 160 ? 'linear-gradient(135deg, #1a1d27 0%, rgba(245,166,35,0.05) 100%)' : '#1a1d27'
                        }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '16px' }}>
                                <div style={{ width: '40px', height: '40px', borderRadius: '10px', backgroundColor: `${currentRatio ? ratioColor(currentRatio) : '#8892a4'}18`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                                    <TrendingDown size={20} color={currentRatio ? ratioColor(currentRatio) : '#8892a4'} />
                                </div>
                                <div>
                                    <div style={{ fontSize: '12px', color: '#8892a4' }}>整戶融資維持率（現況）</div>
                                    <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px', marginTop: '2px' }}>
                                        <span style={{ fontSize: '28px', fontWeight: 700, color: currentRatio ? ratioColor(currentRatio) : '#8892a4' }}>
                                            {currentRatio !== null ? `${currentRatio.toFixed(1)}%` : positions.length === 0 ? '無融資部位' : '—'}
                                        </span>
                                        {currentRatio !== null && (
                                            <span style={{ fontSize: '12px', fontWeight: 600, padding: '2px 10px', borderRadius: '20px', backgroundColor: `${ratioColor(currentRatio)}18`, color: ratioColor(currentRatio) }}>
                                                {ratioLabel(currentRatio)}
                                            </span>
                                        )}
                                    </div>
                                    <div style={{ fontSize: '11px', color: '#8892a4', marginTop: '2px' }}>
                                        {!hasPrice ? '尚未更新現價，以買入成本估算' : '以最新現價計算'}
                                    </div>
                                </div>
                            </div>

                            {/* 三欄數字 */}
                            {positions.length > 0 && (
                                <div style={{ display: 'flex', gap: '24px', flexWrap: 'wrap', marginBottom: '16px' }}>
                                    <div>
                                        <div style={{ fontSize: '11px', color: '#8892a4', marginBottom: '4px' }}>融資股票市值</div>
                                        <div style={{ fontSize: '15px', fontWeight: 600, color: '#e2e8f0' }}>${totalMV.toLocaleString('zh-TW', { maximumFractionDigits: 0 })}</div>
                                    </div>
                                    <div>
                                        <div style={{ fontSize: '11px', color: '#8892a4', marginBottom: '4px' }}>融資借款合計</div>
                                        <div style={{ fontSize: '15px', fontWeight: 600, color: '#f5a623' }}>${totalDebt.toLocaleString('zh-TW', { maximumFractionDigits: 0 })}</div>
                                    </div>
                                    <div>
                                        <div style={{ fontSize: '11px', color: '#8892a4', marginBottom: '4px' }}>融資部位數</div>
                                        <div style={{ fontSize: '15px', fontWeight: 600, color: '#a78bfa' }}>{positions.length} 檔</div>
                                    </div>
                                    {currentRatio !== null && (
                                        <>
                                            <div>
                                                <div style={{ fontSize: '11px', color: '#8892a4', marginBottom: '4px' }}>距追繳線(130%)緩衝</div>
                                                <div style={{ fontSize: '15px', fontWeight: 600, color: totalMV - totalDebt * 1.30 >= 0 ? '#00c896' : '#ff5757' }}>
                                                    ${(totalMV - totalDebt * 1.30).toLocaleString('zh-TW', { maximumFractionDigits: 0 })}
                                                </div>
                                            </div>
                                            <div>
                                                <div style={{ fontSize: '11px', color: '#8892a4', marginBottom: '4px' }}>距斷頭線(120%)緩衝</div>
                                                <div style={{ fontSize: '15px', fontWeight: 600, color: totalMV - totalDebt * 1.20 >= 0 ? '#00c896' : '#ff5757' }}>
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
                                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '10px', color: '#8892a4', marginBottom: '4px' }}>
                                        <span>斷頭線 120%</span><span>追繳線 130%</span><span>安全線 160%</span><span>目前 {currentRatio.toFixed(1)}%</span>
                                    </div>
                                    <div style={{ height: '6px', backgroundColor: '#0f1117', borderRadius: '3px', overflow: 'hidden', position: 'relative' }}>
                                        <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(to right, rgba(255,87,87,0.3) 0%, rgba(255,87,87,0.3) 20%, rgba(245,166,35,0.3) 20%, rgba(245,166,35,0.3) 40%, rgba(0,200,150,0.2) 40%, rgba(0,200,150,0.2) 100%)' }} />
                                        <div style={{ position: 'absolute', left: 0, top: 0, height: '100%', width: `${Math.min(currentRatio / 250 * 100, 100)}%`, backgroundColor: ratioColor(currentRatio), borderRadius: '3px', transition: 'width 0.4s ease' }} />
                                    </div>
                                </div>
                            )}

                            {currentRatio !== null && currentRatio < 130 && (
                                <div style={{ marginTop: '12px', padding: '8px 12px', backgroundColor: 'rgba(255,87,87,0.08)', border: '1px solid rgba(255,87,87,0.25)', borderRadius: '8px', fontSize: '12px', color: '#ff5757' }}>
                                    ⚠️ 維持率低於 130%，請留意追繳風險！強制斷頭線為 120%。
                                </div>
                            )}
                        </div>

                        {/* ── 兩欄：個股明細 + 試算 ── */}
                        <div className="mm-grid">
                            {/* 個股明細 */}
                            <div style={card}>
                                <div style={{ fontSize: '14px', fontWeight: 600, color: '#e2e8f0', marginBottom: '16px' }}>融資個股明細</div>
                                {positions.length === 0 ? (
                                    <div style={{ textAlign: 'center', padding: '40px', color: '#8892a4', fontSize: '13px' }}>目前無融資部位</div>
                                ) : (
                                    <div style={{ overflowX: 'auto' }}>
                                        <table className="mm-table">
                                            <thead>
                                                <tr>
                                                    <th>代號</th><th>股數</th><th>市值</th><th>借款</th><th>個別維持率</th>
                                                </tr>
                                            </thead>
                                            <tbody>
                                                {positions.map(m => {
                                                    const mv = m.currentPrice !== null ? m.currentPrice * m.shares : m.marginCost
                                                    const r = m.marginAmount > 0 ? (mv / m.marginAmount) * 100 : 0
                                                    return (
                                                        <tr key={m.code}>
                                                            <td>
                                                                <div style={{ fontWeight: 700, color: '#4f8ef7' }}>{m.code}</div>
                                                                <div style={{ fontSize: '11px', color: '#8892a4' }}>{m.name}</div>
                                                            </td>
                                                            <td>{m.shares.toLocaleString()}</td>
                                                            <td>${mv.toLocaleString('zh-TW', { maximumFractionDigits: 0 })}</td>
                                                            <td style={{ color: '#f5a623' }}>${m.marginAmount.toLocaleString('zh-TW', { maximumFractionDigits: 0 })}</td>
                                                            <td>
                                                                <span style={{ color: ratioColor(r), fontWeight: 700 }}>{r.toFixed(0)}%</span>
                                                                <span style={{ fontSize: '11px', marginLeft: '4px', color: ratioColor(r) }}>{ratioLabel(r)}</span>
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
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                        <Calculator size={15} color="#4f8ef7" />
                                        <span style={{ fontSize: '14px', fontWeight: 600, color: '#e2e8f0' }}>加碼試算</span>
                                    </div>
                                    <div style={{ display: 'flex', gap: '6px' }}>
                                        <button onClick={addRow} style={{ display: 'flex', alignItems: 'center', gap: '4px', padding: '5px 10px', backgroundColor: 'rgba(79,142,247,0.12)', border: '1px solid rgba(79,142,247,0.3)', borderRadius: '6px', color: '#4f8ef7', fontSize: '12px', cursor: 'pointer' }}>
                                            <Plus size={12} />新增一筆
                                        </button>
                                        <button onClick={clearAll} style={{ padding: '5px 10px', backgroundColor: '#21253a', border: '1px solid #2e3349', borderRadius: '6px', color: '#8892a4', fontSize: '12px', cursor: 'pointer' }}>清除</button>
                                    </div>
                                </div>

                                <div style={{ display: 'flex', gap: '6px', fontSize: '11px', color: '#8892a4', marginBottom: '8px', paddingBottom: '6px', borderBottom: '1px solid #2e3349' }}>
                                    <span style={{ width: '70px' }}>代號</span>
                                    <span style={{ width: '90px' }}>買入價</span>
                                    <span style={{ width: '80px' }}>股數</span>
                                    <span style={{ width: '70px' }}>融資成數</span>
                                </div>

                                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '16px' }}>
                                    {simRows.map((row, idx) => (
                                        <div key={row.id} style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                                            <input className="sim-input" style={{ width: '70px' }} placeholder="代號" value={row.code} onChange={e => updateRow(row.id, 'code', e.target.value)} />
                                            <input className="sim-input" type="number" placeholder="價格" value={row.price} onChange={e => updateRow(row.id, 'price', e.target.value)} />
                                            <input className="sim-input" style={{ width: '80px' }} type="number" placeholder="股數" value={row.shares} onChange={e => updateRow(row.id, 'shares', e.target.value)} />
                                            <input className="sim-input" style={{ width: '70px' }} type="number" placeholder="0.6" value={row.ratio} onChange={e => updateRow(row.id, 'ratio', e.target.value)} />
                                            {rowResults[idx] && (
                                                <span style={{ fontSize: '13px', fontWeight: 700, color: ratioColor(rowResults[idx]!.newMarginRatio), minWidth: '55px' }}>
                                                    {rowResults[idx]!.newMarginRatio.toFixed(1)}%
                                                </span>
                                            )}
                                            {simRows.length > 1 && (
                                                <button onClick={() => removeRow(row.id)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#ff5757', padding: '2px' }}>
                                                    <Trash2 size={13} />
                                                </button>
                                            )}
                                        </div>
                                    ))}
                                </div>

                                {/* 試算結果總覽 */}
                                {finalRatio !== null ? (
                                    <div style={{ backgroundColor: '#0f1117', borderRadius: '10px', padding: '14px 16px', border: `1px solid ${ratioColor(finalRatio)}28` }}>
                                        <div style={{ fontSize: '12px', color: '#8892a4', marginBottom: '10px' }}>加碼後整戶結果</div>
                                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
                                            <div>
                                                <div style={{ fontSize: '11px', color: '#8892a4', marginBottom: '2px' }}>加碼後維持率</div>
                                                <div style={{ fontSize: '22px', fontWeight: 700, color: ratioColor(finalRatio) }}>{finalRatio.toFixed(1)}%</div>
                                                <div style={{ fontSize: '11px', color: ratioColor(finalRatio), fontWeight: 600 }}>{ratioLabel(finalRatio)}</div>
                                            </div>
                                            <div>
                                                <div style={{ fontSize: '11px', color: '#8892a4', marginBottom: '2px' }}>較現在變化</div>
                                                <div style={{ fontSize: '18px', fontWeight: 700, color: finalRatio >= (currentRatio ?? 0) ? '#00c896' : '#ff5757' }}>
                                                    {finalRatio >= (currentRatio ?? 0) ? '+' : ''}{(finalRatio - (currentRatio ?? 0)).toFixed(1)}%
                                                </div>
                                            </div>
                                            <div>
                                                <div style={{ fontSize: '11px', color: '#8892a4', marginBottom: '2px' }}>合計新增借款</div>
                                                <div style={{ fontSize: '14px', fontWeight: 600, color: '#f5a623' }}>${totalAddedDebt.toLocaleString('zh-TW', { maximumFractionDigits: 0 })}</div>
                                            </div>
                                            <div>
                                                <div style={{ fontSize: '11px', color: '#8892a4', marginBottom: '2px' }}>合計需自備款</div>
                                                <div style={{ fontSize: '14px', fontWeight: 600, color: '#e2e8f0' }}>${totalAddedEquity.toLocaleString('zh-TW', { maximumFractionDigits: 0 })}</div>
                                            </div>
                                            <div>
                                                <div style={{ fontSize: '11px', color: '#8892a4', marginBottom: '2px' }}>距追繳線(130%)緩衝</div>
                                                <div style={{ fontSize: '14px', fontWeight: 600, color: accMV - accDebt * 1.30 >= 0 ? '#00c896' : '#ff5757' }}>
                                                    ${(accMV - accDebt * 1.30).toLocaleString('zh-TW', { maximumFractionDigits: 0 })}
                                                </div>
                                            </div>
                                            <div>
                                                <div style={{ fontSize: '11px', color: '#8892a4', marginBottom: '2px' }}>距斷頭線(120%)緩衝</div>
                                                <div style={{ fontSize: '14px', fontWeight: 600, color: accMV - accDebt * 1.20 >= 0 ? '#00c896' : '#ff5757' }}>
                                                    ${(accMV - accDebt * 1.20).toLocaleString('zh-TW', { maximumFractionDigits: 0 })}
                                                </div>
                                            </div>
                                        </div>

                                        {/* 試算後進度條 */}
                                        <div style={{ marginTop: '12px' }}>
                                            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '10px', color: '#8892a4', marginBottom: '4px' }}>
                                                <span>斷頭 120%</span><span>追繳 130%</span><span>安全 160%</span><span>試算後 {finalRatio.toFixed(1)}%</span>
                                            </div>
                                            <div style={{ height: '6px', backgroundColor: '#21253a', borderRadius: '3px', overflow: 'hidden', position: 'relative' }}>
                                                <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(to right, rgba(255,87,87,0.3) 0%, rgba(255,87,87,0.3) 20%, rgba(245,166,35,0.3) 20%, rgba(245,166,35,0.3) 40%, rgba(0,200,150,0.2) 40%, rgba(0,200,150,0.2) 100%)' }} />
                                                {currentRatio !== null && (
                                                    <div style={{ position: 'absolute', left: 0, top: 0, height: '100%', width: `${Math.min(currentRatio / 250 * 100, 100)}%`, backgroundColor: `${ratioColor(currentRatio)}50`, borderRadius: '3px' }} />
                                                )}
                                                <div style={{ position: 'absolute', left: 0, top: 0, height: '100%', width: `${Math.min(finalRatio / 250 * 100, 100)}%`, backgroundColor: ratioColor(finalRatio), borderRadius: '3px', transition: 'width 0.4s ease' }} />
                                            </div>
                                            {currentRatio !== null && (
                                                <div style={{ fontSize: '10px', color: '#8892a4', marginTop: '4px' }}>淡色：現況 {currentRatio.toFixed(1)}%　亮色：試算後</div>
                                            )}
                                        </div>
                                    </div>
                                ) : (
                                    <div style={{ textAlign: 'center', padding: '32px', color: '#3d4460', fontSize: '13px' }}>
                                        輸入買入價格與股數後<br />自動計算加碼後維持率
                                    </div>
                                )}

                                <div style={{ marginTop: '14px', padding: '10px 12px', backgroundColor: 'rgba(79,142,247,0.06)', borderRadius: '8px', fontSize: '11px', color: '#8892a4', lineHeight: 1.6 }}>
                                    💡 支援多筆同時試算，維持率逐筆累計計算。融資成數預設 0.6（六成）。
                                </div>
                            </div>
                        </div>
                    </>
                )}
            </div>
        </>
    )
}