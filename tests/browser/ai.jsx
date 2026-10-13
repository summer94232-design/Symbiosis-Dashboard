import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from '../../src/App'
import { ThemeProvider } from '../../src/ThemeContext'
import ThemeToggle from '../../src/components/ThemeToggle'
import { APP_VERSION } from '../../src/lib/appVersion'
import { state } from './services.mjs'
import { aiFixture, installAiFixture } from './ai-services.mjs'
import { aiSession } from '../../src/lib/aiSession'
import '../../src/index.css'
import './system-preview.css'
import './ai-preview.css'

// Render the production App and theme, replacing data services only.
// Other application fetches fail closed; the AI reply is an in-memory demonstration.
installAiFixture()
const seed = (collection, id, data) => state.rows.set(`users/fixture-A/${collection}/${id}`, data)
seed('settings', 'profile', { displayName: '本機預覽' })
seed('settings', 'stockGroups', { '2330': '半導體', '0050': '被動式ETF', '00981A': '主動式ETF' })
seed('cashflow', 'deposit', { date: '2026-09-01', type: 'in', amount: 350000, note: '示範入金' })
for (const [code, name, shares, price] of [['2330', '台積電', 1000, 100], ['0050', '元大台灣50', 2000, 60], ['00981A', '主動統一台股增長', 1000, 10]]) {
  seed('trades', `buy-${code}`, { date: '2026-09-02', type: 'buy', code, name, shares, price, fee: 100, tax: 0, total: shares * price + 100, isMargin: false })
  seed('watchlist', code, { code, name, market: 'tw', addedAt: '2026-09-02', group: '台股', currentPrice: price, note: '示範追蹤' })
}
for (const [date, value] of [['2026-09-01',350000], ['2026-09-08',352000], ['2026-09-15',354000], ['2026-09-22',356000], ['2026-09-30',360000]]) {
  seed('assetSnapshots', date, { date, totalAssets: value, marketValue: value - 119700, cash: 119700, valuationBasis: 'closing' })
}
for (const [id, title, hashtags, content] of [
  ['future', '散熱產業研究', ['投資/產業'], '2025 年研究：預期散熱產業在 2028 年帶來新訂單。\n需追蹤訂單時程與股價反映程度。'],
  ['learning', '閱讀與知識整理', ['學習/閱讀'], '閱讀重點：將觀察、證據與尚未確認的想法分開整理。'],
  ['recipe', '番茄炒蛋食譜', ['生活/食譜'], '番茄與雞蛋分開拌炒，再合併調味，保留蛋的口感。'],
]) {
  seed('notes', id, { title, type: 'note', hashtags, links: [], createdAt: '2025-03-01T09:00:00', updatedAt: '2026-10-02T09:00:00' })
  seed('noteBodies', id, { content })
}

const root = createRoot(document.getElementById('root'))
root.render(<ThemeProvider><BrowserRouter>
  <div className="preview-toolbar ai-preview-toolbar"><span className="ai-preview-label">本機 AI 預覽 · 示範資料 <small>{APP_VERSION}</small></span><div className="ai-preview-controls">
    <select aria-label="測試回覆模式" defaultValue="normal" onChange={e=>{aiFixture.mode=e.target.value;aiFixture.calls.length=0}}><option value="normal">正常回覆</option><option value="delay">等待回覆</option><option value="fail">模擬失敗</option><option value="format">格式顯示</option><option value="memory">長聊示範</option><option value="reading">分批閱讀示範</option><option value="recovery">摘要保留示範</option><option value="status-delay">設定載入中</option><option value="status-fail">設定載入失敗</option></select>
    <button onClick={async()=>{aiFixture.mode='memory';aiFixture.calls.length=0;aiSession.clear();for(let i=0;i<12;i++){aiSession.setDraft(`第 ${i+1} 輪：延續 2027 年研究 2028 年發展的題材，查證日期仍未知。`);await aiSession.send('/invest')} const chats=aiFixture.calls.filter(v=>v.action==='chat');document.getElementById('ai-memory-metrics').textContent=`完成 ${chats.length} 輪 · 最後送入 ${chats.at(-1)?.historyCharacters||0} 字`}}>12 輪長聊示範</button><span id="ai-memory-metrics" />
    <button onClick={()=>{aiFixture.pending.splice(0).forEach(resolve=>resolve())}}>完成回覆</button>
    <span className="ai-preview-scope">固定範例 · 不連接 Google／Firebase</span><div className="ai-preview-theme"><ThemeToggle /></div></div></div>
  <App />
</BrowserRouter></ThemeProvider>)
if (import.meta.hot) import.meta.hot.dispose(() => root.unmount())
