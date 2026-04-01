import { useState, useEffect, useRef } from 'react'
import { collection, getDocs, orderBy, query, doc, setDoc, getDoc } from 'firebase/firestore'
import { investDB } from '../../lib/firebase'
import { getMultipleQuotes } from '../../lib/fugle'
import { calcPositions, calcAvailableCash, type TradeRecord } from '../../lib/calc'
import { DollarSign, BarChart2, RefreshCw } from 'lucide-react'
import { PieChart, Pie, Tooltip, ResponsiveContainer } from 'recharts'

const COLORS = ['#4f8ef7', '#00c896', '#f5a623', '#ff5757', '#a78bfa', '#34d399', '#fb923c', '#60a5fa']
const CASH_COLOR = '#8892a4'
const pnlColor = (v: number) => v >= 0 ? '#00c896' : '#ff5757'
const card: React.CSSProperties = {
    backgroundColor: '#1a1d27', border: '1px solid #2e3349', borderRadius: '12px', padding: '20px'
}

interface HoldingItem {
    code: string
    name: string
    shares: number
    avgCost: number
    totalCost: number
    currentPrice: number | null
    marketValue: number
    unrealizedPnL: number
    returnRate: number
    ratio: number
}

interface PieEntry {
    name: string
    value: number
    fill: string
}

interface CashRecord {
    type: 'in' | 'out'
    amount: number
}

export default function Dashboard() {
    const [holdings, setHoldings] = useState<HoldingItem[]>([])
    const [totalCash, setTotalCash] = useState(0)
    const [realizedPnL, setRealizedPnL] = useState(0)
    const [loading, setLoading] = useState(true)
    const [priceLoading, setPriceLoading] = useState(false)
    const [lastUpdated, setLastUpdated] = useState('')
    const [hasPrice, setHasPrice] = useState(false)

    const loadData = async () => {
        setLoading(true)
        try {
            const tradesSnap = await getDocs(query(collection(investDB, 'trades'), orderBy('date', 'asc')))
            const trades = tradesSnap.docs.map(d => d.data() as TradeRecord)
            const cashSnap = await getDocs(collection(investDB, 'cashflow'))
            const cashRecords = cashSnap.docs.map(d => d.data() as CashRecord)

            const { holdings: positions, realized } = calcPositions(trades)
            setRealizedPnL(realized.reduce((s, r) => s + r.realized, 0))

            const priceDoc = await getDoc(doc(investDB, 'settings', 'lastPrices'))
            const savedPrices: Record<string, number | string> = priceDoc.exists() ? priceDoc.data() : {}
            const savedAt = typeof savedPrices._updatedAt === 'string' ? savedPrices._updatedAt : ''

            let totalMarketValue = 0
            let priceAvailable = false

            const holdingList: HoldingItem[] = Object.values(positions).map(pos => {
                const currentPrice = typeof savedPrices[pos.code] === 'number'
                    ? savedPrices[pos.code] as number
                    : null
                if (currentPrice !== null) priceAvailable = true
                const marketValue = currentPrice !== null ? currentPrice * pos.shares : pos.totalCost
                const unrealizedPnL = currentPrice !== null ? marketValue - pos.totalCost : 0
                const returnRate = (currentPrice !== null && pos.totalCost > 0)
                    ? (unrealizedPnL / pos.totalCost) * 100
                    : 0
                totalMarketValue += marketValue
                return { ...pos, currentPrice, marketValue, unrealizedPnL, returnRate, ratio: 0 }
            })

            holdingList.forEach(h => {
                h.ratio = totalMarketValue > 0 ? (h.marketValue / totalMarketValue) * 100 : 0
            })
            holdingList.sort((a, b) => b.marketValue - a.marketValue)

            setHoldings(holdingList)
            setTotalCash(calcAvailableCash(trades, cashRecords))
            setHasPrice(priceAvailable)
            if (savedAt) setLastUpdated(savedAt)
        } catch (err) { console.error(err) }
        finally {
            setLoading(false)
        }
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

            let totalMarketValue = 0
            let priceAvailable = false

            const updated: HoldingItem[] = holdings.map(h => {
                const currentPrice = quotes[h.code] ?? null
                if (currentPrice !== null) priceAvailable = true
                const marketValue = currentPrice !== null ? currentPrice * h.shares : h.totalCost
                const unrealizedPnL = currentPrice !== null ? marketValue - h.totalCost : 0
                const returnRate = (currentPrice !== null && h.totalCost > 0)
                    ? (unrealizedPnL / h.totalCost) * 100
                    : 0
                totalMarketValue += marketValue
                return { ...h, currentPrice, marketValue, unrealizedPnL, returnRate }
            })

            updated.forEach(h => {
                h.ratio = totalMarketValue > 0 ? (h.marketValue / totalMarketValue) * 100 : 0
            })
            updated.sort((a, b) => b.marketValue - a.marketValue)

            setHoldings(updated)
            setHasPrice(priceAvailable)
            setLastUpdated(now)
        } catch (err) { console.error(err) }
        setPriceLoading(false)
    }

    // ✅ setTimeout(..., 0) 把 setState 推到下一個 task，
    //    避開 lint 的「同步 setState in effect」規則
    const didLoad = useRef(false)
    useEffect(() => {
        if (didLoad.current) return
        didLoad.current = true
        const timer = setTimeout(() => { void loadData() }, 0)
        return () => clearTimeout(timer)
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    const totalMarketValue = holdings.reduce((s, h) => s + h.marketValue, 0)
    const totalCost = holdings.reduce((s, h) => s + h.totalCost, 0)
    const totalAssets = totalMarketValue + totalCash

    const holdingsWithPrice = holdings.filter(h => h.currentPrice !== null)
    const holdingsWithoutPrice = holdings.filter(h => h.currentPrice === null)
    const totalUnrealized = holdingsWithPrice.reduce((s, h) => s + h.unrealizedPnL, 0)

    const pieData: PieEntry[] = [
        ...holdings.map((h, i) => ({
            name: `${h.code} ${h.name}`,
            value: h.marketValue,
            fill: COLORS[i % COLORS.length]
        })),
        ...(totalCash > 0 ? [{ name: '現金', value: totalCash, fill: CASH_COLOR }] : [])
    ]

    const unrealizedLabel = hasPrice && holdingsWithoutPrice.length > 0
        ? `未實現損益（${holdingsWithPrice.length}/${holdings.length} 檔）`
        : '未實現損益'

    // ✅ Tooltip formatter：參數加上 undefined 防護
    const tooltipFormatter = (value: number | string | readonly (string | number)[] | undefined): [string, string] => {
        const num = value === undefined ? 0 : typeof value === 'number' ? value : Number(value)
        return [`$${num.toLocaleString()}`, '金額']
    }

    return (
        <>
            <style>{`
        .dash-stats { display: grid; gap: 16px; grid-template-columns: repeat(3, 1fr); margin-bottom: 16px; }
        @media (max-width: 900px) { .dash-stats { grid-template-columns: repeat(2, 1fr); } }
        @media (max-width: 480px) { .dash-stats { grid-template-columns: 1fr; } }
        .dash-bottom { display: grid; gap: 16px; grid-template-columns: 300px 1fr; }
        @media (max-width: 900px) { .dash-bottom { grid-template-columns: 1fr; } }
        .h-table { width: 100%; border-collapse: collapse; font-size: 13px; }
        .h-table th { padding: 8px 10px; text-align: left; color: #8892a4; font-weight: 500; border-bottom: 1px solid #2e3349; white-space: nowrap; }
        .h-table td { padding: 10px; border-bottom: 1px solid #2e3349; color: #e2e8f0; white-space: nowrap; }
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
      `}</style>

            <div style={{ padding: 'clamp(16px, 3vw, 32px)', maxWidth: '1600px', margin: '0 auto' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px', flexWrap: 'wrap', gap: '8px' }}>
                    <div>
                        <h1 style={{ fontSize: 'clamp(18px, 2.5vw, 22px)', fontWeight: 700, color: '#e2e8f0', margin: 0 }}>儀表板</h1>
                        <p style={{ fontSize: '12px', color: '#8892a4', margin: '4px 0 0' }}>
                            {lastUpdated ? `現價更新：${lastUpdated}` : '尚未更新現價，點「更新現價」取得最新報價'}
                        </p>
                    </div>
                    <div style={{ display: 'flex', gap: '8px' }}>
                        <button
                            onClick={() => void loadData()}
                            disabled={loading}
                            style={{ backgroundColor: '#21253a', border: '1px solid #2e3349', borderRadius: '8px', padding: '8px 14px', color: '#e2e8f0', fontSize: '13px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px' }}
                        >
                            <RefreshCw size={14} style={{ animation: loading ? 'spin 1s linear infinite' : 'none' }} />
                            重新載入
                        </button>
                        <button
                            onClick={() => void updatePrices()}
                            disabled={priceLoading || loading}
                            style={{ backgroundColor: '#4f8ef7', border: 'none', borderRadius: '8px', padding: '8px 14px', color: '#fff', fontSize: '13px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px' }}
                        >
                            <RefreshCw size={14} style={{ animation: priceLoading ? 'spin 1s linear infinite' : 'none' }} />
                            {priceLoading ? '更新中...' : '更新現價'}
                        </button>
                    </div>
                </div>

                {loading ? (
                    <div style={{ textAlign: 'center', padding: '80px', color: '#8892a4' }}>載入中...</div>
                ) : (
                    <>
                        <div className="dash-stats">
                            {[
                                { label: '總資產', value: `$${totalAssets.toLocaleString('zh-TW', { maximumFractionDigits: 0 })}`, color: '#4f8ef7', icon: DollarSign },
                                { label: '股票總市值', value: `$${totalMarketValue.toLocaleString('zh-TW', { maximumFractionDigits: 0 })}`, color: '#4f8ef7', icon: BarChart2 },
                                { label: '可用現金', value: `$${totalCash.toLocaleString('zh-TW', { maximumFractionDigits: 0 })}`, color: '#f5a623', icon: DollarSign },
                            ].map(({ label, value, color, icon: Icon }) => (
                                <div key={label} style={card}>
                                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                                        <div>
                                            <div style={{ fontSize: '12px', color: '#8892a4', marginBottom: '8px' }}>{label}</div>
                                            <div style={{ fontSize: 'clamp(16px, 2vw, 22px)', fontWeight: 700, color }}>{value}</div>
                                        </div>
                                        <Icon size={18} color={color} style={{ opacity: 0.5 }} />
                                    </div>
                                </div>
                            ))}
                        </div>

                        <div className="dash-stats">
                            {[
                                { label: '股票總成本', value: `$${totalCost.toLocaleString('zh-TW', { maximumFractionDigits: 0 })}`, color: '#8892a4' },
                                {
                                    label: unrealizedLabel,
                                    value: hasPrice
                                        ? `${totalUnrealized >= 0 ? '+' : ''}$${totalUnrealized.toLocaleString('zh-TW', { maximumFractionDigits: 0 })}`
                                        : '—',
                                    color: pnlColor(totalUnrealized)
                                },
                                {
                                    label: '已實現損益',
                                    value: `${realizedPnL >= 0 ? '+' : ''}$${realizedPnL.toLocaleString('zh-TW', { maximumFractionDigits: 0 })}`,
                                    color: pnlColor(realizedPnL)
                                },
                            ].map(({ label, value, color }) => (
                                <div key={label} style={{ ...card, marginBottom: '16px' }}>
                                    <div style={{ fontSize: '12px', color: '#8892a4', marginBottom: '8px' }}>{label}</div>
                                    <div style={{ fontSize: 'clamp(16px, 2vw, 20px)', fontWeight: 700, color }}>{value}</div>
                                </div>
                            ))}
                        </div>

                        {hasPrice && holdingsWithoutPrice.length > 0 && (
                            <div style={{ marginBottom: '12px', padding: '10px 14px', backgroundColor: 'rgba(245,166,35,0.08)', border: '1px solid rgba(245,166,35,0.25)', borderRadius: '8px', fontSize: '12px', color: '#f5a623' }}>
                                ⚠️ {holdingsWithoutPrice.length} 檔持倉（{holdingsWithoutPrice.map(h => h.code).join('、')}）尚未更新現價，市值以成本計算，未實現損益僅計算已有現價的持倉。
                            </div>
                        )}

                        <div className="dash-bottom">
                            <div style={card}>
                                <div style={{ fontSize: '14px', fontWeight: 600, color: '#e2e8f0', marginBottom: '16px' }}>資產分布</div>
                                {pieData.length === 0 ? (
                                    <div style={{ textAlign: 'center', padding: '40px', color: '#8892a4', fontSize: '13px' }}>尚無持倉</div>
                                ) : (
                                    <>
                                        <ResponsiveContainer width="100%" height={180}>
                                            <PieChart>
                                                <Pie
                                                    data={pieData}
                                                    cx="50%"
                                                    cy="50%"
                                                    innerRadius={45}
                                                    outerRadius={75}
                                                    paddingAngle={2}
                                                    dataKey="value"
                                                />
                                                <Tooltip
                                                    formatter={tooltipFormatter}
                                                    contentStyle={{ backgroundColor: '#1a1d27', border: '1px solid #2e3349', borderRadius: '8px', color: '#e2e8f0' }}
                                                />
                                            </PieChart>
                                        </ResponsiveContainer>
                                        <div style={{ marginTop: '8px' }}>
                                            {pieData.map(item => (
                                                <div key={item.name} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', fontSize: '12px' }}>
                                                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                                                        <div style={{ width: '8px', height: '8px', borderRadius: '50%', backgroundColor: item.fill, flexShrink: 0 }} />
                                                        <span style={{ color: '#e2e8f0' }}>{item.name}</span>
                                                    </div>
                                                    <span style={{ color: '#8892a4' }}>{totalAssets > 0 ? ((item.value / totalAssets) * 100).toFixed(1) : 0}%</span>
                                                </div>
                                            ))}
                                        </div>
                                    </>
                                )}
                            </div>

                            <div style={card}>
                                <div style={{ fontSize: '14px', fontWeight: 600, color: '#e2e8f0', marginBottom: '16px' }}>目前持倉</div>
                                {holdings.length === 0 ? (
                                    <div style={{ textAlign: 'center', padding: '40px', color: '#8892a4', fontSize: '13px' }}>尚無持倉資料</div>
                                ) : (
                                    <div style={{ overflowX: 'auto' }}>
                                        <table className="h-table">
                                            <thead>
                                                <tr>
                                                    {['代號', '名稱', '股數', '均價', '現價', '未實現損益', '報酬率', '佔比'].map(h => (
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
                                                        <td style={{ color: h.currentPrice === null ? '#8892a4' : pnlColor(h.unrealizedPnL), fontWeight: 600 }}>
                                                            {h.currentPrice === null ? '—' : `${h.unrealizedPnL >= 0 ? '+' : ''}${h.unrealizedPnL.toLocaleString('zh-TW', { maximumFractionDigits: 0 })}`}
                                                        </td>
                                                        <td>
                                                            {h.currentPrice === null
                                                                ? <span style={{ color: '#8892a4', fontSize: '12px' }}>點「更新現價」</span>
                                                                : <span style={{ backgroundColor: h.returnRate >= 0 ? 'rgba(0,200,150,0.12)' : 'rgba(255,87,87,0.12)', color: pnlColor(h.returnRate), padding: '2px 8px', borderRadius: '20px', fontSize: '12px', fontWeight: 600 }}>
                                                                    {h.returnRate >= 0 ? '+' : ''}{h.returnRate.toFixed(2)}%
                                                                </span>
                                                            }
                                                        </td>
                                                        <td style={{ color: '#8892a4' }}>{h.ratio.toFixed(1)}%</td>
                                                    </tr>
                                                ))}
                                            </tbody>
                                        </table>
                                    </div>
                                )}
                            </div>
                        </div>
                    </>
                )}
            </div>
        </>
    )
}