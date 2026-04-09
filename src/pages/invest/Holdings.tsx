import { useState, useEffect } from 'react'
import { collection, getDocs, orderBy, query, doc, getDoc, setDoc } from 'firebase/firestore'
import { investDB } from '../../lib/firebase'
import { calcPositions, type TradeRecord, type DividendRecord } from '../../lib/calc'
import { getMultipleQuotes } from '../../lib/fugle'
import { RefreshCw, TrendingUp, TrendingDown } from 'lucide-react'

interface DisplayHolding {
    code: string
    name: string
    shares: number
    avgCost: number
    currentPrice: number | null
    marketValue: number
    totalCost: number
    unrealizedPnL: number
    returnRate: number
}

export default function Holdings() {
    const [holdings, setHoldings] = useState<DisplayHolding[]>([])
    const [loading, setLoading] = useState(true)
    const [priceLoading, setPriceLoading] = useState(false)
    const [lastUpdated, setLastUpdated] = useState('')

    const load = async () => {
        setLoading(true)
        try {
            const [snap, divSnap] = await Promise.all([
                getDocs(query(collection(investDB, 'trades'), orderBy('date', 'asc'))),
                getDocs(collection(investDB, 'dividends')),
            ])
            const trades = snap.docs.map(d => d.data() as TradeRecord)
            const dividends = divSnap.docs.map(d => d.data() as DividendRecord)
            // ✅ 修正：將 dividends 傳入 calcPositions 統一處理配股
            // 原本在此手動處理配股，但空倉時會跳過（導致全數出清後的配股股數消失）
            const { holdings: positions } = calcPositions(trades, dividends)

            // 讀取 Firebase 儲存的現價（跟儀表板共用）
            const priceDoc = await getDoc(doc(investDB, 'settings', 'lastPrices'))
            const savedPrices: Record<string, any> = priceDoc.exists() ? priceDoc.data() : {}
            const savedAt = savedPrices._updatedAt || ''
            if (savedAt) setLastUpdated(savedAt)

            const list: DisplayHolding[] = Object.values(positions).map(pos => {
                const currentPrice = savedPrices[pos.code] ?? null
                const marketValue = currentPrice ? currentPrice * pos.shares : pos.totalCost
                const unrealizedPnL = currentPrice ? marketValue - pos.totalCost : 0
                const returnRate = pos.totalCost > 0 ? (unrealizedPnL / pos.totalCost) * 100 : 0
                return {
                    code: pos.code, name: pos.name, shares: pos.shares,
                    avgCost: pos.avgCost, currentPrice, marketValue,
                    totalCost: pos.totalCost, unrealizedPnL, returnRate
                }
            }).sort((a, b) => b.marketValue - a.marketValue)

            setHoldings(list)
        } catch (err) { console.error(err) }
        setLoading(false)
    }

    const updatePrices = async () => {
        setPriceLoading(true)
        try {
            const symbols = holdings.map(h => h.code)
            if (symbols.length === 0) { setPriceLoading(false); return }

            const quotes = await getMultipleQuotes(symbols)
            const now = new Date().toLocaleString('zh-TW')

            const priceData: Record<string, number | string> = { _updatedAt: now }
            symbols.forEach(s => { if (quotes[s] !== null) priceData[s] = quotes[s] as number })
            await setDoc(doc(investDB, 'settings', 'lastPrices'), priceData)

            const updated: DisplayHolding[] = holdings.map(h => {
                const currentPrice = quotes[h.code] ?? null
                const marketValue = currentPrice !== null ? currentPrice * h.shares : h.totalCost
                const unrealizedPnL = currentPrice !== null ? marketValue - h.totalCost : 0
                const returnRate = (currentPrice !== null && h.totalCost > 0)
                    ? (unrealizedPnL / h.totalCost) * 100
                    : 0
                return { ...h, currentPrice, marketValue, unrealizedPnL, returnRate }
            }).sort((a, b) => b.marketValue - a.marketValue)

            setHoldings(updated)
            setLastUpdated(now)
        } catch (err) { console.error(err) }
        setPriceLoading(false)
    }

    useEffect(() => { load() }, [])

    const totalMarketValue = holdings.reduce((s, h) => s + h.marketValue, 0)
    const totalCost = holdings.reduce((s, h) => s + h.totalCost, 0)
    const totalPnL = holdings.reduce((s, h) => s + h.unrealizedPnL, 0)
    const totalReturn = totalCost > 0 ? (totalPnL / totalCost) * 100 : 0
    const hasPrice = holdings.some(h => h.currentPrice !== null)
    const pnlColor = (v: number) => v >= 0 ? '#00c896' : '#ff5757'
    const card: React.CSSProperties = { backgroundColor: '#1a1d27', border: '1px solid #2e3349', borderRadius: '12px', padding: '20px' }

    return (
        <>
            <style>{`
        .holdings-stats { display: grid; gap: 16px; grid-template-columns: repeat(4, 1fr); margin-bottom: 20px; }
        @media (max-width: 900px) { .holdings-stats { grid-template-columns: repeat(2, 1fr); } }
        @media (max-width: 480px) { .holdings-stats { grid-template-columns: 1fr; } }
        .table-wrap { overflow-x: auto; }
        .holdings-table { width: 100%; border-collapse: collapse; font-size: 14px; }
        .holdings-table th, .holdings-table td { padding: 12px 14px; text-align: left; white-space: nowrap; }
        .holdings-table th { color: #8892a4; font-weight: 500; border-bottom: 1px solid #2e3349; font-size: 13px; }
        .holdings-table td { border-bottom: 1px solid #2e3349; color: #e2e8f0; }
        .holdings-table tr:hover td { background-color: rgba(79,142,247,0.04); }
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
      `}</style>

            <div style={{ padding: 'clamp(16px, 3vw, 32px)', maxWidth: '1600px', margin: '0 auto' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px', flexWrap: 'wrap', gap: '8px' }}>
                    <div>
                        <h1 style={{ fontSize: 'clamp(18px, 2.5vw, 22px)', fontWeight: 700, color: '#e2e8f0', margin: 0 }}>股票持倉</h1>
                        <p style={{ fontSize: '13px', color: '#8892a4', margin: '4px 0 0' }}>
                            {lastUpdated ? `現價更新：${lastUpdated}` : '尚未更新現價，請點「更新現價」'}
                        </p>
                    </div>
                    <div style={{ display: 'flex', gap: '8px' }}>
                        <button onClick={load} disabled={loading} style={{ backgroundColor: '#21253a', border: '1px solid #2e3349', borderRadius: '8px', padding: '8px 14px', color: '#e2e8f0', fontSize: '13px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px' }}>
                            <RefreshCw size={14} style={{ animation: loading ? 'spin 1s linear infinite' : 'none' }} />
                            {loading ? '載入中...' : '重新載入'}
                        </button>
                        <button onClick={updatePrices} disabled={priceLoading || loading} style={{ backgroundColor: '#4f8ef7', border: 'none', borderRadius: '8px', padding: '8px 14px', color: '#fff', fontSize: '13px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px' }}>
                            <RefreshCw size={14} style={{ animation: priceLoading ? 'spin 1s linear infinite' : 'none' }} />
                            {priceLoading ? '更新中...' : '更新現價'}
                        </button>
                    </div>
                </div>

                <div className="holdings-stats">
                    {[
                        { label: '持倉總市值', value: totalMarketValue, color: '#4f8ef7', fmt: (v: number) => `$${v.toLocaleString('zh-TW', { maximumFractionDigits: 0 })}` },
                        { label: '持倉總成本', value: totalCost, color: '#8892a4', fmt: (v: number) => `$${v.toLocaleString('zh-TW', { maximumFractionDigits: 0 })}` },
                        { label: '未實現損益', value: totalPnL, color: pnlColor(totalPnL), fmt: (v: number) => hasPrice ? `${v >= 0 ? '+' : ''}$${v.toLocaleString('zh-TW', { maximumFractionDigits: 0 })}` : '—' },
                        { label: '整體報酬率', value: totalReturn, color: pnlColor(totalReturn), fmt: (v: number) => hasPrice ? `${v >= 0 ? '+' : ''}${v.toFixed(2)}%` : '—' },
                    ].map(({ label, value, color, fmt }) => (
                        <div key={label} style={card}>
                            <div style={{ fontSize: '12px', color: '#8892a4', marginBottom: '8px' }}>{label}</div>
                            <div style={{ fontSize: 'clamp(16px, 2vw, 22px)', fontWeight: 700, color, display: 'flex', alignItems: 'center', gap: '6px' }}>
                                {fmt(value)}
                                {label === '未實現損益' && hasPrice && (value >= 0 ? <TrendingUp size={16} /> : <TrendingDown size={16} />)}
                            </div>
                        </div>
                    ))}
                </div>

                <div style={card}>
                    {loading ? (
                        <div style={{ textAlign: 'center', padding: '48px', color: '#8892a4' }}>載入中...</div>
                    ) : holdings.length === 0 ? (
                        <div style={{ textAlign: 'center', padding: '48px', color: '#8892a4' }}>
                            <p style={{ fontSize: '15px' }}>目前沒有持倉</p>
                            <p style={{ fontSize: '13px', marginTop: '8px' }}>請先在買賣紀錄新增買入交易</p>
                        </div>
                    ) : (
                        <div className="table-wrap">
                            <table className="holdings-table">
                                <thead>
                                    <tr>
                                        {['代號', '名稱', '股數', '均價（含手續費）', '現價', '成本', '市值', '未實現損益', '報酬率'].map(h => (
                                            <th key={h}>{h}</th>
                                        ))}
                                    </tr>
                                </thead>
                                <tbody>
                                    {holdings.map(h => (
                                        <tr key={h.code}>
                                            <td style={{ color: '#4f8ef7', fontWeight: 700 }}>{h.code}</td>
                                            <td>{h.name}</td>
                                            <td>{h.shares.toLocaleString()}</td>
                                            <td>{h.avgCost.toFixed(2)}</td>
                                            <td style={{ color: h.currentPrice === null ? '#8892a4' : h.currentPrice > h.avgCost ? '#00c896' : '#ff5757', fontWeight: 600 }}>
                                                {h.currentPrice === null ? '—' : h.currentPrice.toFixed(2)}
                                            </td>
                                            <td>{h.totalCost.toLocaleString('zh-TW', { maximumFractionDigits: 0 })}</td>
                                            <td style={{ color: '#4f8ef7' }}>{h.marketValue.toLocaleString('zh-TW', { maximumFractionDigits: 0 })}</td>
                                            <td>
                                                <span style={{ color: h.currentPrice === null ? '#8892a4' : pnlColor(h.unrealizedPnL), fontWeight: 600 }}>
                                                    {h.currentPrice === null ? '—' : `${h.unrealizedPnL >= 0 ? '+' : ''}${h.unrealizedPnL.toLocaleString('zh-TW', { maximumFractionDigits: 0 })}`}
                                                </span>
                                            </td>
                                            <td>
                                                {h.currentPrice === null ? (
                                                    <span style={{ color: '#8892a4', fontSize: '12px' }}>請更新現價</span>
                                                ) : (
                                                    <span style={{ backgroundColor: h.returnRate >= 0 ? 'rgba(0,200,150,0.12)' : 'rgba(255,87,87,0.12)', color: pnlColor(h.returnRate), padding: '3px 10px', borderRadius: '20px', fontSize: '13px', fontWeight: 600 }}>
                                                        {h.returnRate >= 0 ? '+' : ''}{h.returnRate.toFixed(2)}%
                                                    </span>
                                                )}
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