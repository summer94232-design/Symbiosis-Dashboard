import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import InvestSettings from '../../src/pages/invest/InvestSettings'
import { state, installNetworkFixture } from './services.mjs'
import fixtureBackup from './restore-backup.json'

installNetworkFixture()
const seed = () => {
    state.mode = 'normal'; state.log = []; state.requests = 0; state.rows.clear()
    state.rows.set('users/fixture-A/cashflow/cash', { date: '2026-09-01', type: 'in', amount: 120000 })
    state.rows.set('users/fixture-A/cashflow/retained', { date: '2026-09-02', type: 'out', amount: 2000 })
    state.rows.set('users/fixture-A/watchlist/same', { code: '2330', name: '測試股票' })
    state.rows.set('users/fixture-A/notes/n', { title: '新版測試筆記', content: '新版正文' })
    state.rows.set('users/fixture-A/noteBodies/n', { content: '新版正文', assets: [] })
}
seed()
function Harness() {
    const [revision, setRevision] = useState(0), [status, setStatus] = useState('隔離資料已就緒，尚未寫入')
    return <><style>{`:root{--c-bg:#14182a;--c-card:#1c2235;--c-sidebar:#0f1220;--c-text:#dde2f0;--c-muted:#a1adc9;--c-border:#343c5b;--c-accent:#8b9ef5;--c-warning:#e6bd6a;--c-positive:#6bc9a2;--c-danger:#ff8787;--ui-page-padding:12px;--ui-card-padding:12px}*{box-sizing:border-box}body{margin:0;font-family:system-ui;background:var(--c-bg);color:var(--c-text)}button,input{font:inherit}nav{display:flex;flex-wrap:wrap;gap:6px;padding:8px}nav button{padding:6px;min-height:44px}nav p{margin:0;width:100%;font-size:13px}`}</style>
        <nav aria-label="隔離測試控制">
            <button onClick={() => {
                const input = document.querySelector('input[aria-label="選擇 JSON 備份"]')
                const transfer = new DataTransfer()
                transfer.items.add(new File([JSON.stringify(fixtureBackup)], 'restore-backup.json', { type: 'application/json' }))
                input.files = transfer.files
                input.dispatchEvent(new Event('change', { bubbles: true }))
            }}>載入測試備份</button>
            <button onClick={() => { seed(); setRevision(value => value + 1); setStatus('隔離資料已就緒，尚未寫入') }}>重設測試資料</button>
            <button onClick={() => { state.rows.set('users/fixture-A/cashflow/remote', { date: '2026-09-03', type: 'in', amount: 1000 }); setStatus('模擬雲端已變更') }}>模擬雲端變更</button>
            <button onClick={() => setStatus(`測試寫入 ${state.requests} 批；${state.log.filter(entry => entry.startsWith('set ')).length} 筆文件`)}>查看寫入結果</button>
            <p role="status">{status}</p>
        </nav>
        <InvestSettings key={revision} />
    </>
}
createRoot(document.getElementById('root')).render(<Harness />)
