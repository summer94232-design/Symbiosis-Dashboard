import { useState, useEffect, useRef } from 'react'
import { collection, getDocs, orderBy, query, doc, setDoc, getDoc, updateDoc, addDoc, deleteDoc } from 'firebase/firestore'
import { investDB } from '../../lib/firebase'
import { getMultipleQuotes } from '../../lib/fugle'
import { calcPositions, calcAvailableCash, type TradeRecord } from '../../lib/calc'
import { DollarSign, BarChart2, RefreshCw, Calendar, CheckSquare, Newspaper, Plus, Trash2, Check } from 'lucide-react'
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

interface ScheduleEvent {
    id: string
    title: string
    date: string   // YYYY-MM-DD
    time?: string  // HH:MM
}

interface TodoItem {
    id: string
    text: string
    done: boolean
    createdAt: string
}

interface NewsItem {
    title: string
    url: string
    source: string
    publishedAt: string
}

export default function Dashboard() {
    const [holdings, setHoldings] = useState<HoldingItem[]>([])
    const [totalCash, setTotalCash] = useState(0)
    const [realizedPnL, setRealizedPnL] = useState(0)
    const [loading, setLoading] = useState(true)
    const [priceLoading, setPriceLoading] = useState(false)
    const [lastUpdated, setLastUpdated] = useState('')
    const [hasPrice, setHasPrice] = useState(false)

    // 行程
    const [schedules, setSchedules] = useState<ScheduleEvent[]>([])
    const [newEventTitle, setNewEventTitle] = useState('')
    const [newEventDate, setNewEventDate] = useState('')
    const [newEventTime, setNewEventTime] = useState('')
    const [showAddEvent, setShowAddEvent] = useState(false)

    // 待辦任務
    const [todos, setTodos] = useState<TodoItem[]>([])
    const [newTodoText, setNewTodoText] = useState('')

    // 新聞
    const [news, setNews] = useState<NewsItem[]>([])
    const [newsLoading, setNewsLoading] = useState(false)
    const [newsError, setNewsError] = useState('')

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

    // 載入行程 (近14天)
    const loadSchedules = async () => {
        try {
            const snap = await getDocs(collection(investDB, 'schedules'))
            const all = snap.docs.map(d => ({ id: d.id, ...d.data() } as ScheduleEvent))
            const today = new Date()
            today.setHours(0, 0, 0, 0)
            const future14 = new Date(today)
            future14.setDate(future14.getDate() + 14)
            const filtered = all.filter(e => {
                const d = new Date(e.date)
                return d >= today && d <= future14
            })
            filtered.sort((a, b) => {
                const da = new Date(a.date + (a.time ? 'T' + a.time : ''))
                const db = new Date(b.date + (b.time ? 'T' + b.time : ''))
                return da.getTime() - db.getTime()
            })
            setSchedules(filtered)
        } catch (err) { console.error(err) }
    }

    // 新增行程
    const addEvent = async () => {
        if (!newEventTitle.trim() || !newEventDate) return
        try {
            const newDoc = await addDoc(collection(investDB, 'schedules'), {
                title: newEventTitle.trim(),
                date: newEventDate,
                time: newEventTime || null,
            })
            const newItem: ScheduleEvent = {
                id: newDoc.id,
                title: newEventTitle.trim(),
                date: newEventDate,
                time: newEventTime || undefined,
            }
            setSchedules(prev => {
                const updated = [...prev, newItem].sort((a, b) => {
                    const da = new Date(a.date + (a.time ? 'T' + a.time : ''))
                    const db = new Date(b.date + (b.time ? 'T' + b.time : ''))
                    return da.getTime() - db.getTime()
                })
                return updated
            })
            setNewEventTitle('')
            setNewEventDate('')
            setNewEventTime('')
            setShowAddEvent(false)
        } catch (err) { console.error(err) }
    }

    // 刪除行程
    const deleteEvent = async (id: string) => {
        try {
            await deleteDoc(doc(investDB, 'schedules', id))
            setSchedules(prev => prev.filter(e => e.id !== id))
        } catch (err) { console.error(err) }
    }

    // 載入待辦
    const loadTodos = async () => {
        try {
            const snap = await getDocs(collection(investDB, 'todos'))
            const items = snap.docs.map(d => ({ id: d.id, ...d.data() } as TodoItem))
            items.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
            setTodos(items)
        } catch (err) { console.error(err) }
    }

    // 新增待辦
    const addTodo = async () => {
        if (!newTodoText.trim()) return
        try {
            const newDoc = await addDoc(collection(investDB, 'todos'), {
                text: newTodoText.trim(),
                done: false,
                createdAt: new Date().toISOString(),
            })
            setTodos(prev => [...prev, {
                id: newDoc.id,
                text: newTodoText.trim(),
                done: false,
                createdAt: new Date().toISOString(),
            }])
            setNewTodoText('')
        } catch (err) { console.error(err) }
    }

    // 切換待辦狀態
    const toggleTodo = async (id: string, done: boolean) => {
        try {
            await updateDoc(doc(investDB, 'todos', id), { done: !done })
            setTodos(prev => prev.map(t => t.id === id ? { ...t, done: !done } : t))
        } catch (err) { console.error(err) }
    }

    // 刪除待辦
    const deleteTodo = async (id: string) => {
        try {
            await deleteDoc(doc(investDB, 'todos', id))
            setTodos(prev => prev.filter(t => t.id !== id))
        } catch (err) { console.error(err) }
    }

    // 載入國際新聞（使用 Claude API + web_search）
    const loadNews = async () => {
        setNewsLoading(true)
        setNewsError('')
        try {
            const today = new Date().toLocaleDateString('zh-TW', { year: 'numeric', month: 'long', day: 'numeric' })
            const response = await fetch('https://api.anthropic.com/v1/messages', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: 'claude-sonnet-4-20250514',
                    max_tokens: 1000,
                    tools: [{ type: 'web_search_20250305', name: 'web_search' }],
                    system: `你是一個國際新聞摘要助手。請用繁體中文回覆。
今天是 ${today}。
請搜尋今日最重要的 5 則國際新聞，並以 JSON 格式回傳（不要加 markdown 代碼塊），格式如下：
{"news":[{"title":"新聞標題（繁體中文翻譯）","source":"來源媒體","publishedAt":"時間描述","url":"新聞連結"}]}
只回傳 JSON，不要其他文字。`,
                    messages: [{ role: 'user', content: '請給我今日最重要的 5 則國際新聞摘要。' }],
                })
            })
            const data = await response.json()
            // 從 content blocks 中取出文字
            const textBlocks = (data.content || []).filter((b: { type: string }) => b.type === 'text')
            const rawText = textBlocks.map((b: { text: string }) => b.text).join('')
            // 清理並解析 JSON
            const clean = rawText.replace(/```json|```/g, '').trim()
            const parsed = JSON.parse(clean)
            setNews(parsed.news || [])
        } catch (err) {
            console.error(err)
            setNewsError('新聞載入失敗，請稍後再試')
        }
        setNewsLoading(false)
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

    const didLoad = useRef(false)
    useEffect(() => {
        if (didLoad.current) return
        didLoad.current = true
        const timer = setTimeout(() => {
            void loadData()
            void loadSchedules()
            void loadTodos()
        }, 0)
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

    const tooltipFormatter = (value: number | string | readonly (string | number)[] | undefined): [string, string] => {
        const num = value === undefined ? 0 : typeof value === 'number' ? value : Number(value)
        return [`$${num.toLocaleString()}`, '金額']
    }

    // 格式化行程日期
    const formatEventDate = (dateStr: string, timeStr?: string) => {
        const d = new Date(dateStr)
        const today = new Date(); today.setHours(0, 0, 0, 0)
        const tomorrow = new Date(today); tomorrow.setDate(tomorrow.getDate() + 1)
        const eventDay = new Date(d); eventDay.setHours(0, 0, 0, 0)
        const diff = Math.round((eventDay.getTime() - today.getTime()) / 86400000)
        let label = ''
        if (diff === 0) label = '今天'
        else if (diff === 1) label = '明天'
        else label = `${diff} 天後`
        const mmdd = `${d.getMonth() + 1}/${d.getDate()}`
        return `${mmdd}（${label}）${timeStr ? ' ' + timeStr : ''}`
    }

    const pendingTodos = todos.filter(t => !t.done)
    const doneTodos = todos.filter(t => t.done)

    return (
        <>
            <style>{`
        .dash-stats { display: grid; gap: 16px; grid-template-columns: repeat(3, 1fr); margin-bottom: 16px; }
        @media (max-width: 900px) { .dash-stats { grid-template-columns: repeat(2, 1fr); } }
        @media (max-width: 480px) { .dash-stats { grid-template-columns: 1fr; } }
        .dash-bottom { display: grid; gap: 16px; grid-template-columns: 300px 1fr; }
        @media (max-width: 900px) { .dash-bottom { grid-template-columns: 1fr; } }
        .dash-extra { display: grid; gap: 16px; grid-template-columns: 1fr 1fr 1fr; margin-top: 16px; }
        @media (max-width: 1100px) { .dash-extra { grid-template-columns: 1fr 1fr; } }
        @media (max-width: 700px) { .dash-extra { grid-template-columns: 1fr; } }
        .h-table { width: 100%; border-collapse: collapse; font-size: 13px; }
        .h-table th { padding: 8px 10px; text-align: left; color: #8892a4; font-weight: 500; border-bottom: 1px solid #2e3349; white-space: nowrap; }
        .h-table td { padding: 10px; border-bottom: 1px solid #2e3349; color: #e2e8f0; white-space: nowrap; }
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        .todo-item:hover .todo-del { opacity: 1 !important; }
        .event-item:hover .event-del { opacity: 1 !important; }
        .news-item { padding: 10px 0; border-bottom: 1px solid #2e3349; }
        .news-item:last-child { border-bottom: none; }
        .news-link { color: #e2e8f0; text-decoration: none; font-size: 13px; line-height: 1.5; display: block; }
        .news-link:hover { color: #4f8ef7; }
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
                                <div key={label} style={{ ...card }}>
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

                        {/* ── 三欄：近14天行程 / 待辦任務 / 今日國際新聞 ── */}
                        <div className="dash-extra">

                            {/* 近14天行程 */}
                            <div style={card}>
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '14px' }}>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                        <Calendar size={15} color="#4f8ef7" />
                                        <span style={{ fontSize: '14px', fontWeight: 600, color: '#e2e8f0' }}>近 14 天行程</span>
                                    </div>
                                    <button
                                        onClick={() => setShowAddEvent(v => !v)}
                                        style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#4f8ef7', display: 'flex', alignItems: 'center', padding: '2px' }}
                                        title="新增行程"
                                    >
                                        <Plus size={16} />
                                    </button>
                                </div>

                                {showAddEvent && (
                                    <div style={{ marginBottom: '12px', padding: '10px', backgroundColor: '#21253a', borderRadius: '8px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                                        <input
                                            type="text"
                                            placeholder="行程名稱"
                                            value={newEventTitle}
                                            onChange={e => setNewEventTitle(e.target.value)}
                                            style={{ backgroundColor: '#1a1d27', border: '1px solid #2e3349', borderRadius: '6px', padding: '6px 10px', color: '#e2e8f0', fontSize: '12px', outline: 'none' }}
                                        />
                                        <div style={{ display: 'flex', gap: '6px' }}>
                                            <input
                                                type="date"
                                                value={newEventDate}
                                                onChange={e => setNewEventDate(e.target.value)}
                                                style={{ flex: 1, backgroundColor: '#1a1d27', border: '1px solid #2e3349', borderRadius: '6px', padding: '6px 10px', color: '#e2e8f0', fontSize: '12px', outline: 'none' }}
                                            />
                                            <input
                                                type="time"
                                                value={newEventTime}
                                                onChange={e => setNewEventTime(e.target.value)}
                                                style={{ width: '90px', backgroundColor: '#1a1d27', border: '1px solid #2e3349', borderRadius: '6px', padding: '6px 10px', color: '#e2e8f0', fontSize: '12px', outline: 'none' }}
                                            />
                                        </div>
                                        <div style={{ display: 'flex', gap: '6px' }}>
                                            <button onClick={() => void addEvent()} style={{ flex: 1, backgroundColor: '#4f8ef7', border: 'none', borderRadius: '6px', padding: '6px', color: '#fff', fontSize: '12px', cursor: 'pointer' }}>新增</button>
                                            <button onClick={() => setShowAddEvent(false)} style={{ flex: 1, backgroundColor: '#21253a', border: '1px solid #2e3349', borderRadius: '6px', padding: '6px', color: '#8892a4', fontSize: '12px', cursor: 'pointer' }}>取消</button>
                                        </div>
                                    </div>
                                )}

                                {schedules.length === 0 ? (
                                    <div style={{ textAlign: 'center', padding: '30px 0', color: '#8892a4', fontSize: '13px' }}>近 14 天無行程</div>
                                ) : (
                                    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', maxHeight: '280px', overflowY: 'auto' }}>
                                        {schedules.map(ev => (
                                            <div key={ev.id} className="event-item" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', padding: '8px 10px', backgroundColor: '#21253a', borderRadius: '8px' }}>
                                                <div>
                                                    <div style={{ fontSize: '13px', color: '#e2e8f0', fontWeight: 500 }}>{ev.title}</div>
                                                    <div style={{ fontSize: '11px', color: '#4f8ef7', marginTop: '2px' }}>{formatEventDate(ev.date, ev.time)}</div>
                                                </div>
                                                <button
                                                    className="event-del"
                                                    onClick={() => void deleteEvent(ev.id)}
                                                    style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#ff5757', opacity: 0, padding: '2px', transition: 'opacity 0.2s', flexShrink: 0 }}
                                                >
                                                    <Trash2 size={13} />
                                                </button>
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </div>

                            {/* 待辦任務 */}
                            <div style={card}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '14px' }}>
                                    <CheckSquare size={15} color="#00c896" />
                                    <span style={{ fontSize: '14px', fontWeight: 600, color: '#e2e8f0' }}>待辦任務</span>
                                    {pendingTodos.length > 0 && (
                                        <span style={{ backgroundColor: 'rgba(0,200,150,0.15)', color: '#00c896', borderRadius: '20px', padding: '1px 8px', fontSize: '11px', fontWeight: 600 }}>
                                            {pendingTodos.length}
                                        </span>
                                    )}
                                </div>

                                {/* 新增輸入 */}
                                <div style={{ display: 'flex', gap: '6px', marginBottom: '12px' }}>
                                    <input
                                        type="text"
                                        placeholder="新增待辦..."
                                        value={newTodoText}
                                        onChange={e => setNewTodoText(e.target.value)}
                                        onKeyDown={e => { if (e.key === 'Enter') void addTodo() }}
                                        style={{ flex: 1, backgroundColor: '#21253a', border: '1px solid #2e3349', borderRadius: '6px', padding: '6px 10px', color: '#e2e8f0', fontSize: '12px', outline: 'none' }}
                                    />
                                    <button onClick={() => void addTodo()} style={{ backgroundColor: '#00c896', border: 'none', borderRadius: '6px', padding: '6px 10px', color: '#fff', fontSize: '12px', cursor: 'pointer', display: 'flex', alignItems: 'center' }}>
                                        <Plus size={14} />
                                    </button>
                                </div>

                                <div style={{ display: 'flex', flexDirection: 'column', gap: '5px', maxHeight: '240px', overflowY: 'auto' }}>
                                    {todos.length === 0 && (
                                        <div style={{ textAlign: 'center', padding: '20px 0', color: '#8892a4', fontSize: '13px' }}>尚無待辦事項</div>
                                    )}
                                    {pendingTodos.map(t => (
                                        <div key={t.id} className="todo-item" style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '7px 10px', backgroundColor: '#21253a', borderRadius: '8px' }}>
                                            <button onClick={() => void toggleTodo(t.id, t.done)} style={{ background: 'none', border: '1.5px solid #2e3349', borderRadius: '4px', width: '16px', height: '16px', cursor: 'pointer', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }} />
                                            <span style={{ flex: 1, fontSize: '13px', color: '#e2e8f0' }}>{t.text}</span>
                                            <button className="todo-del" onClick={() => void deleteTodo(t.id)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#ff5757', opacity: 0, transition: 'opacity 0.2s', padding: '2px' }}>
                                                <Trash2 size={13} />
                                            </button>
                                        </div>
                                    ))}
                                    {doneTodos.length > 0 && (
                                        <>
                                            <div style={{ fontSize: '11px', color: '#8892a4', padding: '4px 0 2px', borderTop: '1px solid #2e3349', marginTop: '4px' }}>已完成</div>
                                            {doneTodos.map(t => (
                                                <div key={t.id} className="todo-item" style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '7px 10px', backgroundColor: '#21253a', borderRadius: '8px', opacity: 0.5 }}>
                                                    <button onClick={() => void toggleTodo(t.id, t.done)} style={{ background: 'rgba(0,200,150,0.2)', border: '1.5px solid #00c896', borderRadius: '4px', width: '16px', height: '16px', cursor: 'pointer', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                                                        <Check size={10} color="#00c896" />
                                                    </button>
                                                    <span style={{ flex: 1, fontSize: '13px', color: '#8892a4', textDecoration: 'line-through' }}>{t.text}</span>
                                                    <button className="todo-del" onClick={() => void deleteTodo(t.id)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#ff5757', opacity: 0, transition: 'opacity 0.2s', padding: '2px' }}>
                                                        <Trash2 size={13} />
                                                    </button>
                                                </div>
                                            ))}
                                        </>
                                    )}
                                </div>
                            </div>

                            {/* 今日國際新聞 */}
                            <div style={card}>
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '14px' }}>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                        <Newspaper size={15} color="#a78bfa" />
                                        <span style={{ fontSize: '14px', fontWeight: 600, color: '#e2e8f0' }}>今日國際新聞</span>
                                    </div>
                                    <button
                                        onClick={() => void loadNews()}
                                        disabled={newsLoading}
                                        style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#a78bfa', display: 'flex', alignItems: 'center', padding: '2px' }}
                                        title="重新載入新聞"
                                    >
                                        <RefreshCw size={14} style={{ animation: newsLoading ? 'spin 1s linear infinite' : 'none' }} />
                                    </button>
                                </div>

                                {newsLoading ? (
                                    <div style={{ textAlign: 'center', padding: '40px 0', color: '#8892a4', fontSize: '13px' }}>
                                        <RefreshCw size={20} style={{ animation: 'spin 1s linear infinite', margin: '0 auto 8px', display: 'block' }} color="#a78bfa" />
                                        搜尋最新新聞中...
                                    </div>
                                ) : newsError ? (
                                    <div style={{ textAlign: 'center', padding: '20px 0', color: '#ff5757', fontSize: '13px' }}>{newsError}</div>
                                ) : news.length === 0 ? (
                                    <div style={{ textAlign: 'center', padding: '30px 0', color: '#8892a4', fontSize: '13px' }}>
                                        <Newspaper size={28} style={{ opacity: 0.3, marginBottom: '8px', display: 'block', margin: '0 auto 8px' }} />
                                        點右上角按鈕載入今日新聞
                                    </div>
                                ) : (
                                    <div style={{ maxHeight: '320px', overflowY: 'auto' }}>
                                        {news.map((item, i) => (
                                            <div key={i} className="news-item">
                                                <a href={item.url} target="_blank" rel="noopener noreferrer" className="news-link">
                                                    {item.title}
                                                </a>
                                                <div style={{ display: 'flex', gap: '8px', marginTop: '4px' }}>
                                                    <span style={{ fontSize: '11px', color: '#a78bfa' }}>{item.source}</span>
                                                    <span style={{ fontSize: '11px', color: '#8892a4' }}>{item.publishedAt}</span>
                                                </div>
                                            </div>
                                        ))}
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