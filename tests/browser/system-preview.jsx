import { createRoot } from 'react-dom/client'
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom'
import App from '../../src/App'
import { ThemeProvider } from '../../src/ThemeContext'
import { APP_VERSION } from '../../src/lib/appVersion'
import { installNetworkFixture, state } from './services.mjs'
import '../../src/index.css'
import './system-preview.css'

installNetworkFixture()
const seed = (collection, id, data) => state.rows.set(`users/fixture-A/${collection}/${id}`, data)
seed('settings', 'profile', { displayName: '預覽帳號' })
seed('settings', 'stockGroups', { '2330': '半導體', '0050': '被動式ETF', '00981A': '主動式ETF' })
seed('cashflow', 'deposit', { date: '2026-09-01', type: 'in', amount: 350000, note: '示範入金' })
for (const [code, name, shares, price] of [['2330', '台積電', 1000, 100], ['0050', '元大台灣50', 2000, 60], ['00981A', '主動統一台股增長', 1000, 10]]) {
  seed('trades', `buy-${code}`, { date: '2026-09-02', type: 'buy', code, name, shares, price, fee: 100, tax: 0, total: shares * price + 100, isMargin: false })
  seed('watchlist', code, { code, name, market: 'tw', addedAt: '2026-09-02', group: '台股', currentPrice: price, note: '示範追蹤' })
}
seed('settings', 'prices', { '2330': 105, '0050': 62, '00981A': 11, _date: '2026-10-02' })
for (const [date, value] of [['2026-09-01',350000], ['2026-09-08',352000], ['2026-09-15',354000], ['2026-09-22',356000], ['2026-09-30',360000]]) {
  seed('assetSnapshots', date, { date, totalAssets: value, marketValue: value - 119700, cash: 119700, valuationBasis: 'closing' })
}
for (const [id, title, tags, content] of [
  ['invest', '投資觀察筆記', ['投資/台股'], '記錄觀察重點、持倉變化與下次檢查項目。'],
  ['learning', '學習與知識整理', ['學習'], '整理閱讀重點，將相關觀念連結成知識脈絡。'],
  ['plan', '每週回顧', ['生活'], '回顧本週完成事項與下一步安排。'],
]) {
  seed('notes', id, { title, type: 'note', hashtags: tags, links: id === 'invest' ? ['learning'] : [], createdAt: '2026-10-02T09:00:00', updatedAt: '2026-10-02T09:00:00' })
  seed('noteBodies', id, { content })
}
seed('taskProjects', 'weekly', { title: '本週安排', color: '#8b9cf6', order: 0, createdAt: '2026-10-02' })
seed('tasks', 'review', { title: '檢查投資與現金配置', done: false, priority: 'medium', dueDate: '2026-10-02', projectId: 'weekly', order: 0, createdAt: '2026-10-02', tag: '投資' })
seed('tasks', 'notes', { title: '整理本週學習筆記', done: false, priority: 'low', dueDate: '2026-10-03', projectId: 'weekly', order: 1, createdAt: '2026-10-02', tag: '學習' })
seed('calendarEvents', 'review', { title: '每週回顧', date: '2026-10-02', type: 'personal', description: '示範行程', allDay: true })

const pages = [
  ['/invest','投資・儀表板'], ['/invest/trades','投資・買賣紀錄'], ['/invest/holdings','投資・股票持倉'],
  ['/invest/trend','投資・資產趨勢'], ['/invest/industry','投資・產業地圖'], ['/invest/watchlist','投資・選股追蹤'],
  ['/invest/portfolio-planner','投資・組合水位試算'], ['/invest/margin','投資・融資管理'], ['/invest/sentiment','投資・觀點追蹤'],
  ['/invest/brief','投資・每日重點'], ['/invest/sold-tracker','投資・賣出追蹤'], ['/invest/reconciliation','投資・對帳核對'],
  ['/invest/history','投資・歷史損益'], ['/invest/cashflow','投資・出入金'], ['/invest/dividend','投資・除權息'],
  ['/invest/review','投資・年度復盤'], ['/invest/settings','投資・設定與備份'],
  ['/kms','知識・知識庫'], ['/kms/tags','知識・標籤管理'], ['/kms/export','知識・匯出筆記'], ['/kms/graph','知識・知識圖譜'], ['/kms/trash','知識・垃圾桶'],
  ['/calendar','行事曆・月曆'], ['/calendar/tasks','行事曆・任務管理'], ['/calendar/settings','行事曆・法說會關注清單'],
]
function Preview() {
  const location = useLocation()
  const navigate = useNavigate()
  return <>
    <div className="preview-toolbar">
      <span>本機預覽・示範資料 <small>{APP_VERSION}</small></span>
      <select aria-label="完整預覽頁面" value={location.pathname} onChange={event => navigate(event.target.value)}>
        {pages.map(([path, label]) => <option key={path} value={path}>{label}</option>)}
      </select>
    </div>
    <App />
  </>
}
const root = createRoot(document.getElementById('root'))
root.render(<ThemeProvider><MemoryRouter initialEntries={['/invest']}><Preview /></MemoryRouter></ThemeProvider>)
if (import.meta.hot) import.meta.hot.dispose(() => root.unmount())
