import { useState, useEffect } from 'react'
import { collection, getDocs, orderBy, query } from 'firebase/firestore'
import { investDB } from '../../lib/firebase'
import { userCol, userDoc, userDocNested } from '../../lib/userDB'
import { calcPositions, type TradeRecord, type DividendRecord, type RealizedRecord } from '../../lib/calc'
import { Search } from 'lucide-react'

const card: React.CSSProperties = { backgroundColor: '#1a1d27', border: '1px solid #2e3349', borderRadius: '12px', padding: '20px' }
const inp: React.CSSProperties = { backgroundColor: '#0f1117', border: '1px solid #2e3349', borderRadius: '8px', padding: '8px 12px', color: '#e2e8f0', fontSize: '14px', width: '100%', outline: 'none', boxSizing: 'border-box' }
const pnlColor = (v: number) => v >= 0 ? '#00c896' : '#ff5757'

export default function HistoryPnL() {
    // ✅ 修正：any[] 改為正確型別
    const [records, setRecords] = useState<RealizedRecord[]>([])
    const [dividends, setDividends] = useState<DividendRecord[]>([])
    const [loading, setLoading] = useState(true)
    const [tab, setTab] = useState<'realized' | 'dividend'>('realized')
    const [search, setSearch] = useState('')

    const load = async () => {
        setLoading(true)
        try {
            const [tradesSnap, divSnap] = await Promise.all([
                getDocs(query(userCol(investDB, 'trades'), orderBy('date', 'asc'))),
                getDocs(query(userCol(investDB, 'dividends'), orderBy('date', 'desc'))),
            ])
            const trades = tradesSnap.docs.map(d => d.data() as TradeRecord)
            const dividendRecords = divSnap.docs.map(d => d.data() as DividendRecord)
            setDividends(dividendRecords)
            const { realized } = calcPositions(trades, dividendRecords)
            setRecords(realized)
        } catch (err) { console.error(err) }
        setLoading(false)
    }

    // ✅ 修正：void 明確標示 async 呼叫，避免 linter 誤報 cascading renders
    useEffect(() => { void load() }, [])

    const totalRealized = records.reduce((s, r) => s + r.realized, 0)
    const totalDividend = dividends.reduce((s, d) => s + d.cashDividend, 0)

    // ✅ 修正：用 > 0.5 避免浮點數誤差把 -0.001 元算成虧損
    const winCount = records.filter(r => r.realized > 0.5).length
    const winRate = records.length > 0 ? (winCount / records.length) * 100 : 0

    const filteredRecords = records.filter(r =>
        !search || r.code.toLowerCase().includes(search.toLowerCase()) || r.name.includes(search)
    )
    const filteredDividends = dividends.filter(d =>
        !search || d.code.toLowerCase().includes(search.toLowerCase()) || d.name.includes(search)
    )

    return (
        <>
            <style>{`
        .history-stats { display: grid; gap: 16px; grid-template-columns: repeat(4, 1fr); margin-bottom: 20px; }
        @media (max-width: 900px) { .history-stats { grid-template-columns: repeat(2, 1fr); } }
        @media (max-width: 480px) { .history-stats { grid-template-columns: 1fr; } }
      `}</style>

            <div style={{ padding: 'clamp(16px, 3vw, 32px)', maxWidth: '1600px', margin: '0 auto' }}>
                <div style={{ marginBottom: '24px' }}>
                    <h1 style={{ fontSize: 'clamp(18px, 2.5vw, 22px)', fontWeight: 700, color: '#e2e8f0', margin: 0 }}>歷史損益</h1>
                    <p style={{ fontSize: '13px', color: '#8892a4', margin: '4px 0 0' }}>所有已實現損益與股利紀錄</p>
                </div>

                <div className="history-stats">
                    {[
                        { label: '累計已實現損益', value: totalRealized, color: pnlColor(totalRealized), fmt: (v: number) => `${v >= 0 ? '+' : ''}$${v.toLocaleString('zh-TW', { maximumFractionDigits: 0 })}` },
                        { label: '累計股利收入', value: totalDividend, color: '#4f8ef7', fmt: (v: number) => `$${v.toLocaleString('zh-TW', { maximumFractionDigits: 0 })}` },
                        { label: '交易勝率', value: winRate, color: winRate >= 50 ? '#00c896' : '#ff5757', fmt: (v: number) => records.length > 0 ? `${v.toFixed(1)}%` : '—' },
                        { label: '已實現交易筆數', value: records.length, color: '#e2e8f0', fmt: (v: number) => `${v} 筆` },
                    ].map(({ label, value, color, fmt }) => (
                        <div key={label} style={card}>
                            <div style={{ fontSize: '12px', color: '#8892a4', marginBottom: '8px' }}>{label}</div>
                            <div style={{ fontSize: 'clamp(16px, 2vw, 20px)', fontWeight: 700, color }}>{fmt(value)}</div>
                        </div>
                    ))}
                </div>

                {/* Tab + 搜尋列 */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px', flexWrap: 'wrap', gap: '12px' }}>
                    <div style={{ display: 'flex', gap: '4px', backgroundColor: '#21253a', padding: '4px', borderRadius: '8px' }}>
                        {[{ key: 'realized', label: '已實現損益' }, { key: 'dividend', label: '股利紀錄' }].map(t => (
                            <button key={t.key} onClick={() => setTab(t.key as 'realized' | 'dividend')} style={{ backgroundColor: tab === t.key ? '#1a1d27' : 'transparent', border: 'none', borderRadius: '6px', padding: '6px 16px', color: tab === t.key ? '#e2e8f0' : '#8892a4', fontSize: '14px', cursor: 'pointer', fontWeight: tab === t.key ? 600 : 400 }}>
                                {t.label}
                            </button>
                        ))}
                    </div>
                    <div style={{ position: 'relative', minWidth: '220px' }}>
                        <Search size={15} style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)', color: '#8892a4' }} />
                        <input style={{ ...inp, paddingLeft: '36px', backgroundColor: '#1a1d27' }}
                            placeholder="搜尋代號或名稱..." value={search} onChange={e => setSearch(e.target.value)} />
                    </div>
                </div>

                {/* 已實現損益 */}
                {tab === 'realized' && (
                    <div style={card}>
                        {loading ? (
                            <div style={{ textAlign: 'center', padding: '48px', color: '#8892a4' }}>載入中...</div>
                        ) : filteredRecords.length === 0 ? (
                            <div style={{ textAlign: 'center', padding: '48px', color: '#8892a4' }}>
                                {search ? `找不到「${search}」相關紀錄` : '還沒有已實現損益紀錄'}
                            </div>
                        ) : (
                            <div style={{ overflowX: 'auto' }}>
                                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '14px' }}>
                                    <thead>
                                        <tr style={{ borderBottom: '1px solid #2e3349' }}>
                                            {['賣出日期', '代號', '名稱', '股數', '均買價', '賣出價', '已實現損益', '報酬率'].map(h => (
                                                <th key={h} style={{ padding: '10px 12px', textAlign: 'left', color: '#8892a4', fontWeight: 500, whiteSpace: 'nowrap' }}>{h}</th>
                                            ))}
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {filteredRecords.map((r, i) => (
                                            <tr key={i} style={{ borderBottom: '1px solid #2e3349' }}>
                                                <td style={{ padding: '12px', color: '#8892a4' }}>{r.date}</td>
                                                <td style={{ padding: '12px', color: '#4f8ef7', fontWeight: 600 }}>{r.code}</td>
                                                <td style={{ padding: '12px', color: '#e2e8f0' }}>{r.name}</td>
                                                <td style={{ padding: '12px', color: '#e2e8f0' }}>{r.shares.toLocaleString()}</td>
                                                <td style={{ padding: '12px', color: '#e2e8f0' }}>{r.avgCost.toFixed(2)}</td>
                                                <td style={{ padding: '12px', color: '#e2e8f0' }}>{r.sellPrice.toFixed(2)}</td>
                                                <td style={{ padding: '12px', color: pnlColor(r.realized), fontWeight: 600 }}>
                                                    {r.realized >= 0 ? '+' : ''}{r.realized.toLocaleString('zh-TW', { maximumFractionDigits: 0 })}
                                                </td>
                                                <td style={{ padding: '12px' }}>
                                                    <span style={{ backgroundColor: r.returnRate >= 0 ? 'rgba(0,200,150,0.12)' : 'rgba(255,87,87,0.12)', color: pnlColor(r.returnRate), padding: '3px 10px', borderRadius: '20px', fontSize: '13px', fontWeight: 600 }}>
                                                        {r.returnRate >= 0 ? '+' : ''}{r.returnRate.toFixed(2)}%
                                                    </span>
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        )}
                    </div>
                )}

                {/* 股利 */}
                {tab === 'dividend' && (
                    <div style={card}>
                        {filteredDividends.length === 0 ? (
                            <div style={{ textAlign: 'center', padding: '48px', color: '#8892a4' }}>
                                {search ? `找不到「${search}」相關紀錄` : '還沒有股利紀錄'}
                            </div>
                        ) : (
                            <div style={{ overflowX: 'auto' }}>
                                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '14px' }}>
                                    <thead>
                                        <tr style={{ borderBottom: '1px solid #2e3349' }}>
                                            {['日期', '代號', '名稱', '現金股利', '股票股利', '備註'].map(h => (
                                                <th key={h} style={{ padding: '10px 12px', textAlign: 'left', color: '#8892a4', fontWeight: 500 }}>{h}</th>
                                            ))}
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {filteredDividends.map((d, i) => (
                                            <tr key={i} style={{ borderBottom: '1px solid #2e3349' }}>
                                                <td style={{ padding: '12px', color: '#8892a4' }}>{d.date}</td>
                                                <td style={{ padding: '12px', color: '#4f8ef7', fontWeight: 600 }}>{d.code}</td>
                                                <td style={{ padding: '12px', color: '#e2e8f0' }}>{d.name}</td>
                                                <td style={{ padding: '12px', color: '#00c896', fontWeight: 600 }}>{d.cashDividend.toLocaleString()} 元</td>
                                                <td style={{ padding: '12px', color: '#4f8ef7', fontWeight: 600 }}>{d.stockDividend.toLocaleString()} 股</td>
                                                <td style={{ padding: '12px', color: '#8892a4' }}>{d.note}</td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        )}
                    </div>
                )}
            </div>
        </>
    )
}