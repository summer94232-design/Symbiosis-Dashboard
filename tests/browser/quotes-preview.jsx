import { createRoot } from 'react-dom/client'
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom'
import { useState } from 'react'
import App from '../../src/App'
import { ThemeProvider } from '../../src/ThemeContext'
import { state } from './services.mjs'
import { createBrowserHistoryStore } from '../../src/lib/historyStore'
import { getHistoricalCandles } from '../../src/lib/history'
import '../../src/index.css'
import './system-preview.css'

const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(new Date())
const seed = (collection, id, data) => state.rows.set(`users/fixture-A/${collection}/${id}`, data)
seed('settings', 'profile', { displayName: '隔離測試' })
seed('cashflow', 'deposit', { date: '2026-09-01', type: 'in', amount: 100000 })
for (const code of ['2330', '2317']) seed('trades', code, {
    date: '2026-09-02', type: 'buy', code, name: code === '2330' ? '台積電' : '鴻海', shares: 100, price: 100, total: 10000, fee: 0, tax: 0,
})
seed('watchlist', '0050', { code: '0050', name: '元大台灣50', market: 'tw' })
seed('settings', 'lastPrices', { 2330: 100, 2317: 100 })
seed('assetSnapshots', '2026-09-02', { date: '2026-09-02', totalAssets: 100000, marketValue: 20000, cash: 80000, marginDebt: 0, cashflowBasis: 'after-close-v1', cashflowNetAtCapture: 100000 })
let releaseMarket, releaseSecond
const market = new Promise(resolve => { releaseMarket = resolve })
const second = new Promise(resolve => { releaseSecond = resolve })
let historyCalls = 0
window.fetch = async (url, options = {}) => {
    state.log.push(`HTTP ${url}`)
    const path = String(url)
    if (path.endsWith('fubon-snapshot')) {
        await market
        return Response.json({ snapshots: [{ date: today, fetchedAt: new Date().toISOString(), market: 'TSE', data: [
            { symbol: '2330', lastPrice: 90, isTrial: false }, { symbol: '2317', lastPrice: 90, isTrial: false },
            { symbol: '0050', lastPrice: 80, isTrial: false },
        ] }] })
    }
    if (path.endsWith('fugle-proxy')) {
        const input = JSON.parse(options.body)
        if (input.symbol === '2317') await second
        return Response.json({ date: today, symbol: input.symbol, lastPrice: input.symbol === '2330' ? 120 : input.symbol === '2317' ? 110 : 28000,
            isTrial: false, lastUpdated: Date.now() * 1000 })
    }
    if (path.includes('fugle-proxy?batch=1')) {
        const { symbols } = JSON.parse(options.body)
        const encoder = new TextEncoder()
        return new Response(new ReadableStream({ start(controller) {
            void Promise.all(symbols.map(async symbol => {
                if (symbol === '2317') await second
                const quote = { date: today, symbol, lastPrice: symbol === '2330' ? 120 : symbol === '2317' ? 110 : 28000,
                    isTrial: false, lastUpdated: Date.now() * 1000 }
                controller.enqueue(encoder.encode(JSON.stringify({ symbol, status: 200, quote }) + '\n'))
            })).then(() => { controller.enqueue(encoder.encode('{"done":true}\n')); controller.close() })
        } }), { headers: { 'Content-Type': 'application/x-ndjson' } })
    }
    if (path.endsWith('fubon-history')) {
        historyCalls++
        const { from, to } = JSON.parse(options.body)
        return Response.json({ data: [from, to].filter((value, index, all) => all.indexOf(value) === index)
            .map(date => ({ date, open: 100, high: 110, low: 90, close: 105, volume: 1000 })) })
    }
    if (path.endsWith('dividend-announcements')) return Response.json({ error: '隔離測試略過公告' }, { status: 503 })
    if (path.includes('ai-assistant')) return Response.json({ enabled: false, models: [] })
    if (path.includes('market-reports')) return Response.json({ error: '隔離測試未連結 Google' }, { status: 403 })
    if (path.includes('market-cap-proxy')) return Response.json({})
    throw new Error(`隔離測試禁止外連：${path}`)
}

function Preview() {
    const location = useLocation(), navigate = useNavigate()
    const [inspection, setInspection] = useState(''), [storageResult, setStorageResult] = useState('')
    const inspect = () => {
        const price = state.rows.get('users/fixture-A/settings/lastPrices') || {}
        const snapshot = state.rows.get(`users/fixture-A/assetSnapshots/${today}`)
        setInspection(JSON.stringify({ prices: { 2330: price['2330'], 2317: price['2317'], '0050': price['0050'] },
            snapshot: snapshot ? { date: snapshot.date, totalAssets: snapshot.totalAssets, marketValue: snapshot.marketValue, cash: snapshot.cash } : null,
            marketRequests: state.log.filter(row => row.includes('fubon-snapshot')).length }))
    }
    return <>
        <div className="preview-toolbar" style={{ flexWrap: 'wrap' }}>
            <select aria-label="測試頁面" value={location.pathname} onChange={event => navigate(event.target.value)}>
                <option value="/invest">儀表板</option><option value="/invest/trend">資產趨勢</option><option value="/kms">知識庫</option>
            </select>
            <button onClick={() => releaseSecond()}>完成第二檔持股</button><button onClick={() => releaseMarket()}>完成富邦</button>
            <button onClick={inspect}>檢查保存資料</button>
            <button onClick={async () => {
                const store = createBrowserHistoryStore(), key = 'daily:unadjusted:v1:2330'
                await getHistoricalCandles('2330', '2026-09-01', '2026-09-30')
                const persisted = await store.get(key)
                setStorageResult(JSON.stringify({ persisted: Boolean(persisted?.data?.length), historyCalls }))
            }}>檢查歷史快取</button>
            <output aria-label="保存資料">{inspection}</output><output aria-label="快取結果">{storageResult}</output>
        </div>
        <App />
    </>
}
createRoot(document.getElementById('root')).render(<ThemeProvider><MemoryRouter initialEntries={['/invest']}><Preview /></MemoryRouter></ThemeProvider>)
