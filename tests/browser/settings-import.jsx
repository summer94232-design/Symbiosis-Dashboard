import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import InvestSettings from '../../src/pages/invest/InvestSettings'
import { state, installNetworkFixture, switchAccount, investAuth } from './services.mjs'

installNetworkFixture()
function Harness() {
    const [revision, setRevision] = useState(0), [status, setStatus] = useState('虛構資料，尚未寫入')
    const start = mode => {
        state.mode = mode
        const input = document.querySelector('input[aria-label="匯入出入金"]')
        const transfer = new DataTransfer()
        transfer.items.add(new File(['日期,類型,金額\n2026-09-01,入金,100\n2026-09-02,出金,200'], 'fixture.csv', { type: 'text/csv' }))
        input.files = transfer.files
        input.dispatchEvent(new Event('change', { bubbles: true }))
    }
    return <><style>{`:root{--c-bg:#14182a;--c-card:#1c2235;--c-sidebar:#0f1220;--c-text:#dde2f0;--c-muted:#a1adc9;--c-border:#343c5b;--c-accent:#8b9ef5;--c-warning:#e6bd6a;--c-positive:#6bc9a2;--c-danger:#ff8787;--ui-page-padding:12px;--ui-card-padding:12px}*{box-sizing:border-box}body{margin:0;font-family:system-ui;background:var(--c-bg);color:var(--c-text)}button,input{font:inherit}nav{display:flex;flex-wrap:wrap;gap:6px;padding:8px}nav button{padding:6px;min-height:44px}nav p{margin:0;width:100%;font-size:13px}`}</style>
        <nav aria-label="隔離匯入測試">
            <button onClick={() => { if (investAuth.currentUser.uid !== 'fixture-A') switchAccount(); state.mode = 'normal'; state.rows.clear(); state.log = []; state.requests = 0; setRevision(value => value + 1); setStatus('虛構資料已重設') }}>重設測試</button>
            <button onClick={() => start('normal')}>正常匯入</button>
            <button onClick={() => start('read-fail')}>模擬查詢失敗</button>
            <button onClick={() => start('delay')}>延遲第一筆寫入</button>
            <button onClick={() => { switchAccount(); state.mode = 'normal'; state.pending.splice(0).forEach(resolve => resolve()); setStatus(`已切換為 ${investAuth.currentUser.uid}`) }}>切換帳號並完成寫入</button>
            <button onClick={() => setStatus(`寫入 ${state.log.filter(row => row.startsWith('set ')).length} 筆；${state.log.join('；') || '沒有寫入'}`)}>查看寫入結果</button>
            <p role="status">{status}</p>
        </nav>
        <InvestSettings key={revision} />
    </>
}
createRoot(document.getElementById('root')).render(<Harness />)
