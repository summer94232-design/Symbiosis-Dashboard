import React from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import MarketReportButton from '../../src/components/MarketReportButton'
import { investAuth, switchAccount } from './services.mjs'
import '../../src/index.css'

const mode = new URLSearchParams(location.search).get('mode')
let fail = false, revision = 1
const listeners = new Set()
investAuth.onAuthStateChanged = callback => { listeners.add(callback); callback(investAuth.currentUser); return () => listeners.delete(callback) }
const report = (date, period, title) => ({ id: `${date}:${period === '盤前' ? 'pre' : 'post'}`, date, period, title,
    summary: '這是隔離測試報告：整理市場動態、資金觀察與明日追蹤重點。內容僅供版面驗證，不代表真實市場資訊。',
    updatedAt: `${date} ${period === '盤前' ? '08:58:00' : '18:04:00'}`,
    content: `## 市場重點\n\n這是模擬報告，保留 Markdown 標題、條列、表格與來源連結。\n\n- 市場資訊整理\n- 後續觀察重點\n\n| 項目 | 觀察 | 後續追蹤 |\n| --- | --- | --- |\n| 市場 | 模擬資料 | 持續觀察 |\n| 族群 | 模擬資料 | 核對來源 |\n\n[公開來源](https://example.test/)\n\n<script>alert('unsafe')</script>\n\n[無效連結](javascript:alert('unsafe'))\n\n## 歷史紀錄\n\n${Array.from({length:8},(_,i)=>`第 ${i+1} 段示範閱讀內容。`).join('\n\n')}` })
window.fetch = async (url, init = {}) => {
    if (!String(url).includes('/.netlify/functions/market-reports')) throw new Error('Fixture forbids external requests')
    if (new Headers(init.headers).get('Authorization') !== 'Bearer fixture-token') throw new Error('Missing fixture identity')
    if (mode === 'unlinked') return Response.json({ error: '請到行事曆設定補充報告授權', code: 'GOOGLE_RECONNECT' }, { status: 403 })
    if (fail) return Response.json({ error: '報告讀取未完成，請稍後重試', code: 'SOURCE_UNAVAILABLE' }, { status: 503 })
    if (investAuth.currentUser.uid !== 'fixture-A') return Response.json({ error: '找不到報告資料庫', code: 'REPORT_EMPTY' }, { status: 404 })
    const rows = [report('2026-10-13','盤後',`盤後市場報告（模擬版本 ${revision}）`),report('2026-10-13','盤前','盤前市場報告（歷史模擬）')]
    const selectedId = new URL(String(url),'http://fixture.test').searchParams.get('report')
    return Response.json({ ownerUid: 'fixture-A', latest: rows[0], selected: rows.find(row=>row.id===selectedId)||null,
        reports: rows.map(({id,date,period,title,summary,updatedAt})=>({id,date,period,title,summary,updatedAt})),
        source: { id: `fixture-new-sheet-${revision}`, name: '台股每日投資報告資料庫', createdTime: '2026-10-13T10:04:00Z', fallback: mode==='fallback', invalidRows: 0 }, holidays: [], checkedAt: new Date().toISOString() })
}
createRoot(document.getElementById('root')).render(<MemoryRouter><React.StrictMode>
    <div style={{padding:'12px',maxWidth:'1600px',margin:'auto'}}><h1>儀表板（隔離報告測試）</h1>
        <nav style={{display:'flex',gap:8,marginBottom:12,flexWrap:'wrap'}}>
            <button onClick={()=>{revision++}}>模擬新試算表</button><button onClick={()=>{fail=!fail}}>切換來源斷線</button>
            <button onClick={()=>{switchAccount();listeners.forEach(callback=>callback(investAuth.currentUser))}}>切換測試帳號</button>
        </nav><MarketReportButton /><p>投資指標與其他儀表板內容</p>
    </div>
</React.StrictMode></MemoryRouter>)
