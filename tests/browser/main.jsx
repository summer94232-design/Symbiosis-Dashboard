import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import CashFlow from '../../src/pages/invest/CashFlow'
import Dividend from '../../src/pages/invest/Dividend'
import TaskManager from '../../src/pages/calendar/TaskManager'
import CalendarHome from '../../src/pages/calendar/CalendarHome'
import ExactTwrPanel from '../../src/components/ExactTwrPanel'
import GoogleSeriesEditor from '../../src/components/GoogleSeriesEditor'
import { searchKmsNoteSummaries, invalidateKmsNotes } from '../../src/lib/kmsData'
import { invalidateCalendarEvents } from '../../src/lib/plannerData'
import { performGoogleCalendarSync } from '../../src/lib/googleCalendar'
import { state, investAuth, switchAccount, installNetworkFixture, publishRemoteChange } from './services.mjs'
installNetworkFixture()
function Harness() {
  const [page, setPage] = useState('cash')
  const [uid, setUid] = useState(investAuth.currentUser.uid)
  const [report, setReport] = useState('')
  const [sync, setSync] = useState('')
  const Component = { cash: CashFlow, dividend: Dividend, tasks: TaskManager, calendar: CalendarHome, twr: ExactTwrPanel, series: SeriesFixture }[page]
  return <><style>{`:root{--c-bg:#fff;--c-sidebar:#f5f7fb;--c-border:#ccd3df;--c-text:#182336;--c-muted:#526176;--c-accent:#2862c0;--c-positive:#16784c;--c-danger:#bd2525}body{font-family:sans-serif;margin:20px}button,select{margin:4px;padding:7px}pre{white-space:pre-wrap}`}</style>
    <h1>隔離資料安全驗收（不連接正式資料）</h1>
    <p>目前帳號：{uid}</p>
    <label>測試頁<select aria-label="測試頁" value={page} onChange={e => setPage(e.target.value)}><option value="cash">出入金</option><option value="dividend">除權息</option><option value="tasks">任務</option><option value="calendar">月曆</option><option value="twr">精確 TWR</option><option value="series">整組規則</option></select></label>
    <button onClick={() => {
      state.rows.set(`users/${uid}/cashflow/deposit`, { date: '2026-01-15', type: 'in', amount: 100, note: '隔離入金' })
      state.rows.set(`users/${uid}/settings/googleCalendarAuth`, { calendarId: 'fixture-calendar', refreshToken: 'fixture-token', syncTypes: ['personal'], connectedAt: '' })
      publishRemoteChange(); setReport('已載入精確 TWR 與整組規則測試資料')
    }}>載入 TWR／系列測試資料</button>
    <button onClick={() => { state.rows.set(`users/${uid}/cashflow/deposit`, { date: '2026-01-15', type: 'in', amount: 101 }); publishRemoteChange() }}>模擬帳本金額變更</button>
    <button onClick={() => {
      const prefix=`users/${uid}/`
      state.rows.set(prefix+'notes/body-fixture',{title:'隔離正文筆記',hashtags:[]})
      state.rows.set(prefix+'noteBodies/body-fixture',{content:'這份筆記內文包含 正文獨有關鍵字'})
      state.rows.set(prefix+'calendarEvents/recurring-fixture',{date:'2026-09-09',title:'跨日重複驗收',type:'personal',description:'隔離',updatedAt:'2026-09-09T00:00:00Z',googleEventId:'occurrence',recurringEventId:'series',start:{dateTime:'2026-09-09T23:00:00+08:00'},end:{dateTime:'2026-09-11T01:00:00+08:00'}})
      invalidateKmsNotes();invalidateCalendarEvents();setReport('已載入隔離全文與跨日重複資料，請切換至月曆')
    }}>載入全文／跨日測試資料</button>
    <button onClick={async()=>{try{setReport(JSON.stringify(await searchKmsNoteSummaries('隔離正文筆記','')))}catch(error){setReport(error.message)}}}>驗收標題搜尋</button>
    <button onClick={() => {
      state.rows.set(`users/${uid}/calendarEvents/remote-new`, { title: '另一裝置新增行程', date: '2026-09-09', type: 'personal' })
      invalidateCalendarEvents(); publishRemoteChange()
    }}>模擬另一裝置更新</button>
    <label>資料情境<select aria-label="資料情境" onChange={e => { state.mode = e.target.value }}><option value="normal">正常</option><option value="delay">延遲</option><option value="fail">寫入失敗</option><option value="lost-ack">回覆遺失</option><option value="read-fail">讀取失敗</option></select></label>
    <label>Google 情境<select aria-label="Google 情境" onChange={e => { state.network = e.target.value }}><option value="normal">正常</option><option value="delay">延遲</option><option value="fail">斷線</option></select></label>
    <button onClick={() => state.pending.splice(0).forEach(resolve => resolve())}>完成延遲請求</button>
    <button onClick={() => { switchAccount(); setUid(investAuth.currentUser.uid) }}>切換測試帳號</button>
    <button onClick={() => setReport(JSON.stringify({ requests: state.requests, rows: [...state.rows], log: state.log }, null, 2))}>檢查隔離資料</button>
    <button onClick={async () => { setSync('同步中'); try { setSync(JSON.stringify(await performGoogleCalendarSync({refreshToken:'fixture-only',calendarId:'fixture-calendar',syncTypes:['personal'],connectedAt:''}))) } catch(error) { setSync(error.message) } }}>驗收 Google 同步流程</button>
    <output>{sync}</output><pre>{report}</pre><hr/><Component key={`${uid}/${page}`} />
  </>
}
function SeriesFixture() { return <GoogleSeriesEditor seriesId="series" onClose={() => {}} onRefreshed={() => {}} /> }
createRoot(document.getElementById('root')).render(<Harness />)
