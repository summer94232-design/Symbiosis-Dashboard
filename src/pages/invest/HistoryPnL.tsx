import { useState, useEffect, useMemo } from 'react'
import { getDocs, orderBy, query } from 'firebase/firestore'
import { investDB } from '../../lib/firebase'
import { userCol } from '../../lib/userDB'
import { calcPositions, type TradeRecord, type DividendRecord, type RealizedRecord } from '../../lib/calc'
import { Search, TrendingUp, TrendingDown, Calendar, X } from 'lucide-react'

const card: React.CSSProperties = { backgroundColor: '#1a1d27', border: '1px solid #2e3349', borderRadius: '12px', padding: '20px' }
const inp: React.CSSProperties = { backgroundColor: '#0f1117', border: '1px solid #2e3349', borderRadius: '8px', padding: '8px 12px', color: '#e2e8f0', fontSize: '14px', width: '100%', outline: 'none', boxSizing: 'border-box' }
const pnlColor = (v: number) => v >= 0 ? '#00c896' : '#ff5757'

// 快速時間範圍選項
const RANGE_OPTIONS = [
    { label: '全部', value: 'all' },
    { label: '本月', value: 'month' },
    { label: '近 3 月', value: '3m' },
    { label: '近 6 月', value: '6m' },
    { label: '今年', value: 'year' },
    { label: '自訂', value: 'custom' },
] as const
type RangeOption = typeof RANGE_OPTIONS[number]['value']

function getPresetDates(range: RangeOption): { from: string; to: string } {
    const today = new Date()
    const to = today.toISOString().split('T')[0]
    if (range === 'month') {
        const from = new Date(today.getFullYear(), today.getMonth(), 1).toISOString().split('T')[0]
        return { from, to }
    }
    if (range === '3m') {
        const from = new Date(today.getFullYear(), today.getMonth() - 3, today.getDate()).toISOString().split('T')[0]
        return { from, to }
    }
    if (range === '6m') {
        const from = new Date(today.getFullYear(), today.getMonth() - 6, today.getDate()).toISOString().split('T')[0]
        return { from, to }
    }
    if (range === 'year') {
        const from = `${today.getFullYear()}-01-01`
        return { from, to }
    }
    return { from: '', to: '' }
}

export default function HistoryPnL() {
    const [records, setRecords] = useState<RealizedRecord[]>([])
    const [dividends, setDividends] = useState<DividendRecord[]>([])
    const [loading, setLoading] = useState(true)
    const [tab, setTab] = useState<'realized' | 'dividend'>('realized')
    const [search, setSearch] = useState('')

    // ── 時間篩選 ────────────────────────────────────────────────────────
    const [range, setRange] = useState<RangeOption>('all')
    const [customFrom, setCustomFrom] = useState('')
    const [customTo, setCustomTo] = useState('')

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
            // 最新賣出日期在最前面（降冪）
            setRecords([...realized].sort((a, b) => b.date.localeCompare(a.date)))
        } catch (err) { console.error(err) }
        setLoading(false)
    }

    useEffect(() => { void load() }, [])

    // ── 解析生效中的時間範圍 ──────────────────────────────────────────
    const { from: activeFrom, to: activeTo } = useMemo(() => {
        if (range === 'all') return { from: '', to: '' }
        if (range === 'custom') return { from: customFrom, to: customTo }
        return getPresetDates(range)
    }, [range, customFrom, customTo])

    const inRange = (date: string) => {
        if (!activeFrom && !activeTo) return true
        if (activeFrom && date < activeFrom) return false
        if (activeTo && date > activeTo) return false
        return true
    }

    // ── 篩選（搜尋 + 時間範圍） ──────────────────────────────────────
    const filteredRecords = useMemo(() =>
        records.filter(r => {
            const matchSearch = !search ||
                r.code.toLowerCase().includes(search.toLowerCase()) ||
                r.name.includes(search)
            return matchSearch && inRange(r.date)
        }),
        [records, search, activeFrom, activeTo]
    )

    const filteredDividends = useMemo(() =>
        dividends.filter(d => {
            const matchSearch = !search ||
                d.code.toLowerCase().includes(search.toLowerCase()) ||
                d.name.includes(search)
            return matchSearch && inRange(d.date)
        }),
        [dividends, search, activeFrom, activeTo]
    )

    // ── 統計（依篩選後資料即時計算） ─────────────────────────────────
    const totalRealized = filteredRecords.reduce((s, r) => s + r.realized, 0)
    const totalDividend = filteredDividends.reduce((s, d) => s + d.cashDividend, 0)
    const winCount = filteredRecords.filter(r => r.realized > 0.5).length
    const loseCount = filteredRecords.filter(r => r.realized < -0.5).length
    const winRate = filteredRecords.length > 0 ? (winCount / filteredRecords.length) * 100 : 0
    const avgReturn = filteredRecords.length > 0
        ? (filteredRecords.reduce((s, r) => s + r.returnRate, 0) / filteredRecords.length) * 100
        : 0

    const isFiltered = range !== 'all' || !!search

    const clearFilter = () => {
        setRange('all')
        setCustomFrom('')
        setCustomTo('')
        setSearch('')
    }

    return (
        <>
            <style>{`
                .history-stats { display: grid; gap: 12px; grid-template-columns: repeat(5, 1fr); margin-bottom: 20px; }
                @media (max-width: 1100px) { .history-stats { grid-template-columns: repeat(3, 1fr); } }
                @media (max-width: 600px)  { .history-stats { grid-template-columns: repeat(2, 1fr); } }
                .history-table { width: 100%; border-collapse: collapse; font-size: 14px; }
                .history-table th { padding: 10px 14px; text-align: left; color: #8892a4; font-weight: 500; border-bottom: 1px solid #2e3349; white-space: nowrap; font-size: 12px; }
                .history-table td { padding: 12px 14px; border-bottom: 1px solid #1e2235; color: #e2e8f0; white-space: nowrap; }
                .history-table tr:last-child td { border-bottom: none; }
                .history-table tbody tr:hover td { background-color: rgba(79,142,247,0.04); }
                .range-btn { border: 1px solid #2e3349; border-radius: 6px; padding: 5px 12px; font-size: 12px; cursor: pointer; transition: all 0.15s; background: transparent; color: #8892a4; }
                .range-btn:hover { border-color: #4f8ef7; color: #4f8ef7; }
                .range-btn.active { background: rgba(79,142,247,0.12); border-color: #4f8ef7; color: #4f8ef7; font-weight: 600; }
                .date-inp { background: #0f1117; border: 1px solid #2e3349; border-radius: 6px; padding: 5px 10px; color: #e2e8f0; font-size: 12px; outline: none; cursor: pointer; }
                .date-inp:focus { border-color: #4f8ef7; }
            `}</style>

            <div style={{ padding: 'clamp(16px, 3vw, 32px)', maxWidth: '1600px', margin: '0 auto' }}>

                {/* ── 標題與 Tab 切換 ── */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
                    <div>
                        <h1 style={{ fontSize: 'clamp(18px, 2.5vw, 22px)', fontWeight: 700, color: '#e2e8f0', margin: 0 }}>歷史損益</h1>
                        <p style={{ fontSize: '13px', color: '#8892a4', margin: '4px 0 0' }}>
                            已實現損益與股利紀錄
                            {isFiltered && <span style={{ marginLeft: '8px', color: '#4f8ef7' }}>・篩選中</span>}
                        </p>
                    </div>
                    
                    {/* ── Tab（帶筆數） ── */}
                    <div style={{ display: 'flex', gap: '4px', backgroundColor: '#21253a', padding: '4px', borderRadius: '8px', width: 'fit-content' }}>
                        {[
                            { key: 'realized', label: `已實現損益（${filteredRecords.length}）` },
                            { key: 'dividend', label: `股利紀錄（${filteredDividends.length}）` },
                        ].map(t => (
                            <button key={t.key} onClick={() => setTab(t.key as 'realized' | 'dividend')}
                                style={{ backgroundColor: tab === t.key ? '#1a1d27' : 'transparent', border: 'none', borderRadius: '6px', padding: '6px 18px', color: tab === t.key ? '#e2e8f0' : '#8892a4', fontSize: '13px', cursor: 'pointer', fontWeight: tab === t.key ? 600 : 400, whiteSpace: 'nowrap' }}>
                                {t.label}
                            </button>
                        ))}
                    </div>
                </div>

                {/* ── 統計卡片（篩選後即時更新） ── */}
                <div className="history-stats">
                    {[
                        {
                            label: isFiltered ? '區間已實現損益' : '累計已實現損益',
                            main: `${totalRealized >= 0 ? '+' : ''}$${totalRealized.toLocaleString('zh-TW', { maximumFractionDigits: 0 })}`,
                            color: pnlColor(totalRealized),
                            Icon: totalRealized >= 0 ? TrendingUp : TrendingDown,
                            sub: '',
                        },
                        {
                            label: isFiltered ? '區間股利收入' : '累計股利收入',
                            main: `$${totalDividend.toLocaleString('zh-TW', { maximumFractionDigits: 0 })}`,
                            color: '#4f8ef7',
                            Icon: null,
                            sub: '',
                        },
                        {
                            label: '交易勝率',
                            main: filteredRecords.length > 0 ? `${winRate.toFixed(1)}%` : '—',
                            color: winRate >= 50 ? '#00c896' : '#ff5757',
                            Icon: null,
                            sub: filteredRecords.length > 0 ? `${winCount} 勝 ${loseCount} 敗` : '',
                        },
                        {
                            label: '平均報酬率',
                            main: filteredRecords.length > 0 ? `${avgReturn >= 0 ? '+' : ''}${avgReturn.toFixed(2)}%` : '—',
                            color: pnlColor(avgReturn),
                            Icon: null,
                            sub: '',
                        },
                        {
                            label: '篩選筆數',
                            main: `${filteredRecords.length} 筆`,
                            color: '#e2e8f0',
                            Icon: null,
                            sub: records.length !== filteredRecords.length ? `共 ${records.length} 筆` : '',
                        },
                    ].map(({ label, main, color, Icon, sub }) => (
                        <div key={label} style={card}>
                            <div style={{ fontSize: '11px', color: '#8892a4', marginBottom: '6px' }}>{label}</div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
                                {Icon && <Icon size={14} color={color} />}
                                <span style={{ fontSize: 'clamp(14px, 1.8vw, 18px)', fontWeight: 700, color }}>{main}</span>
                            </div>
                            {sub && <div style={{ fontSize: '11px', color: '#8892a4', marginTop: '3px' }}>{sub}</div>}
                        </div>
                    ))}
                </div>

                {/* ── 篩選列 ── */}
                <div style={{ ...card, marginBottom: '16px', padding: '14px 20px' }}>
                    <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', alignItems: 'center' }}>

                        {/* 快速時間按鈕 */}
                        <div style={{ display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' }}>
                            <Calendar size={13} color="#8892a4" style={{ flexShrink: 0 }} />
                            {RANGE_OPTIONS.map(o => (
                                <button
                                    key={o.value}
                                    className={`range-btn${range === o.value ? ' active' : ''}`}
                                    onClick={() => setRange(o.value)}
                                >{o.label}</button>
                            ))}
                        </div>

                        {/* 自訂日期輸入 */}
                        {range === 'custom' && (
                            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                                <input type="date" className="date-inp"
                                    value={customFrom} onChange={e => setCustomFrom(e.target.value)} />
                                <span style={{ color: '#8892a4', fontSize: '12px' }}>～</span>
                                <input type="date" className="date-inp"
                                    value={customTo} onChange={e => setCustomTo(e.target.value)} />
                            </div>
                        )}

                        <div style={{ width: '1px', height: '20px', backgroundColor: '#2e3349', flexShrink: 0 }} />

                        {/* 搜尋 */}
                        <div style={{ position: 'relative', flex: 1, minWidth: '180px', maxWidth: '260px' }}>
                            <Search size={13} style={{ position: 'absolute', left: '10px', top: '50%', transform: 'translateY(-50%)', color: '#8892a4' }} />
                            <input
                                style={{ ...inp, paddingLeft: '32px', padding: '6px 12px 6px 32px', fontSize: '13px' }}
                                placeholder="搜尋代號或名稱..."
                                value={search} onChange={e => setSearch(e.target.value)}
                            />
                        </div>

                        {/* 清除篩選 */}
                        {isFiltered && (
                            <button onClick={clearFilter}
                                style={{ display: 'flex', alignItems: 'center', gap: '4px', background: 'rgba(255,87,87,0.08)', border: '1px solid rgba(255,87,87,0.25)', borderRadius: '6px', padding: '5px 10px', color: '#ff5757', fontSize: '12px', cursor: 'pointer' }}>
                                <X size={11} />清除篩選
                            </button>
                        )}
                    </div>

                    {/* 生效時間範圍提示 */}
                    {range !== 'all' && (activeFrom || activeTo) && (
                        <div style={{ marginTop: '10px', fontSize: '12px', color: '#4f8ef7' }}>
                            📅 {activeFrom || '最早'} ～ {activeTo || '今日'}
                            　損益 {filteredRecords.length} 筆・股利 {filteredDividends.length} 筆
                        </div>
                    )}
                </div>

                {/* ── 已實現損益表格 ── */}
                {tab === 'realized' && (
                    <div style={card}>
                        {loading ? (
                            <div style={{ textAlign: 'center', padding: '60px', color: '#8892a4' }}>載入中...</div>
                        ) : filteredRecords.length === 0 ? (
                            <div style={{ textAlign: 'center', padding: '60px', color: '#8892a4' }}>
                                <div style={{ fontSize: '32px', marginBottom: '12px' }}>📭</div>
                                <div style={{ fontSize: '14px' }}>{isFiltered ? '此條件下沒有損益紀錄' : '還沒有已實現損益紀錄'}</div>
                                {isFiltered && <div style={{ fontSize: '12px', color: '#3d4460', marginTop: '6px' }}>試著調整篩選條件</div>}
                            </div>
                        ) : (
                            <div style={{ overflowX: 'auto' }}>
                                <table className="history-table">
                                    <thead>
                                        <tr>
                                            {['賣出日期', '代號', '名稱', '股數', '均買價', '賣出價', '已實現損益', '報酬率'].map(h => (
                                                <th key={h}>{h}</th>
                                            ))}
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {filteredRecords.map((r, i) => (
                                            <tr key={i}>
                                                <td style={{ color: '#6b7690', fontSize: '13px' }}>{r.date}</td>
                                                <td><span style={{ color: '#4f8ef7', fontWeight: 700 }}>{r.code}</span></td>
                                                <td style={{ color: '#c8d0e0' }}>{r.name}</td>
                                                <td style={{ color: '#8892a4' }}>{r.shares.toLocaleString()}</td>
                                                <td style={{ color: '#8892a4', fontFamily: 'monospace' }}>{r.avgCost.toFixed(2)}</td>
                                                <td style={{ color: '#e2e8f0', fontFamily: 'monospace', fontWeight: 600 }}>{r.sellPrice.toFixed(2)}</td>
                                                <td>
                                                    <span style={{ color: pnlColor(r.realized), fontWeight: 700 }}>
                                                        {r.realized >= 0 ? '+' : ''}{r.realized.toLocaleString('zh-TW', { maximumFractionDigits: 0 })}
                                                    </span>
                                                </td>
                                                <td>
                                                    <span style={{
                                                        display: 'inline-flex', alignItems: 'center', gap: '3px',
                                                        backgroundColor: r.returnRate >= 0 ? 'rgba(0,200,150,0.12)' : 'rgba(255,87,87,0.12)',
                                                        color: pnlColor(r.returnRate),
                                                        padding: '3px 10px', borderRadius: '20px', fontSize: '12px', fontWeight: 700
                                                    }}>
                                                        {r.returnRate >= 0
                                                            ? <TrendingUp size={11} />
                                                            : <TrendingDown size={11} />}
                                                        {r.returnRate >= 0 ? '+' : ''}{(r.returnRate * 100).toFixed(2)}%
                                                    </span>
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>

                                {/* 區間小計列 */}
                                {filteredRecords.length > 1 && (
                                    <div style={{ marginTop: '16px', padding: '12px 16px', backgroundColor: '#0f1117', borderRadius: '8px', display: 'flex', gap: '28px', flexWrap: 'wrap', alignItems: 'center' }}>
                                        <div>
                                            <span style={{ fontSize: '11px', color: '#8892a4' }}>合計　</span>
                                            <span style={{ fontSize: '15px', fontWeight: 700, color: pnlColor(totalRealized) }}>
                                                {totalRealized >= 0 ? '+' : ''}${totalRealized.toLocaleString('zh-TW', { maximumFractionDigits: 0 })}
                                            </span>
                                        </div>
                                        <div>
                                            <span style={{ fontSize: '11px', color: '#8892a4' }}>勝率　</span>
                                            <span style={{ fontSize: '14px', fontWeight: 600, color: winRate >= 50 ? '#00c896' : '#ff5757' }}>{winRate.toFixed(1)}%</span>
                                            <span style={{ fontSize: '11px', color: '#8892a4', marginLeft: '6px' }}>{winCount} 勝 {loseCount} 敗</span>
                                        </div>
                                        <div>
                                            <span style={{ fontSize: '11px', color: '#8892a4' }}>平均報酬率　</span>
                                            <span style={{ fontSize: '14px', fontWeight: 600, color: pnlColor(avgReturn) }}>
                                                {avgReturn >= 0 ? '+' : ''}{avgReturn.toFixed(2)}%
                                            </span>
                                        </div>
                                    </div>
                                )}
                            </div>
                        )}
                    </div>
                )}

                {/* ── 股利表格 ── */}
                {tab === 'dividend' && (
                    <div style={card}>
                        {filteredDividends.length === 0 ? (
                            <div style={{ textAlign: 'center', padding: '60px', color: '#8892a4' }}>
                                <div style={{ fontSize: '32px', marginBottom: '12px' }}>📭</div>
                                <div style={{ fontSize: '14px' }}>{isFiltered ? '此條件下沒有股利紀錄' : '還沒有股利紀錄'}</div>
                            </div>
                        ) : (
                            <div style={{ overflowX: 'auto' }}>
                                <table className="history-table">
                                    <thead>
                                        <tr>
                                            {['日期', '代號', '名稱', '現金股利', '股票股利', '備註'].map(h => (
                                                <th key={h}>{h}</th>
                                            ))}
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {filteredDividends.map((d, i) => (
                                            <tr key={i}>
                                                <td style={{ color: '#6b7690', fontSize: '13px' }}>{d.date}</td>
                                                <td><span style={{ color: '#4f8ef7', fontWeight: 700 }}>{d.code}</span></td>
                                                <td style={{ color: '#c8d0e0' }}>{d.name}</td>
                                                <td>
                                                    <span style={{ color: '#00c896', fontWeight: 700 }}>{d.cashDividend.toLocaleString()}</span>
                                                    <span style={{ color: '#8892a4', fontSize: '12px' }}> 元</span>
                                                </td>
                                                <td>
                                                    {d.stockDividend > 0
                                                        ? <><span style={{ color: '#4f8ef7', fontWeight: 700 }}>{d.stockDividend.toLocaleString()}</span><span style={{ color: '#8892a4', fontSize: '12px' }}> 股</span></>
                                                        : <span style={{ color: '#3d4460' }}>—</span>
                                                    }
                                                </td>
                                                <td style={{ color: '#6b7690', fontSize: '13px' }}>{d.note || '—'}</td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>

                                {/* 股利小計 */}
                                {filteredDividends.length > 1 && (
                                    <div style={{ marginTop: '16px', padding: '12px 16px', backgroundColor: '#0f1117', borderRadius: '8px', display: 'flex', gap: '28px', flexWrap: 'wrap' }}>
                                        <div>
                                            <span style={{ fontSize: '11px', color: '#8892a4' }}>現金股利合計　</span>
                                            <span style={{ fontSize: '15px', fontWeight: 700, color: '#00c896' }}>
                                                ${totalDividend.toLocaleString('zh-TW', { maximumFractionDigits: 0 })}
                                            </span>
                                        </div>
                                        <div>
                                            <span style={{ fontSize: '11px', color: '#8892a4' }}>筆數　</span>
                                            <span style={{ fontSize: '14px', fontWeight: 600, color: '#e2e8f0' }}>{filteredDividends.length} 筆</span>
                                        </div>
                                    </div>
                                )}
                            </div>
                        )}
                    </div>
                )}

            </div>
        </>
    )
}