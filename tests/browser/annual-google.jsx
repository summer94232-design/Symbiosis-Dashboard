import React,{useState} from 'react'
import {createRoot} from 'react-dom/client'
import CalendarSettings from '../../src/pages/calendar/CalendarSettings'
import AnnualDataNotice from '../../src/components/AnnualDataNotice'
import {loadAnnualCalendars} from '../../src/lib/annualCalendars'
import {FOMC_DATES,FOMC_COVERED_YEARS} from '../../src/lib/calendarData'
import {TWSE_SETTLEMENT_COVERED_YEARS} from '../../src/lib/calc'
import {installNetworkFixture,investAuth,state} from './services.mjs'
import verified from '../fixtures/annual-data/fomc-verified.json'
import '../../src/index.css'
installNetworkFixture()
investAuth.currentUser.getIdTokenResult=async()=>({claims:{auth_time:100}})
const originalFetch=window.fetch
window.fetch=async(url,init)=>{
 if(String(url).endsWith('/annual-calendars'))return Response.json({fomc:Object.fromEntries(Object.entries(verified).map(([year,row])=>[year,{...row,checkedAt:'2026-09-30T10:18:07.964Z'}])),settlement:{},lastSuccessAt:'2026-09-30T10:18:07.964Z'})
 if(String(url).includes('/google-calendar-auth')){
  if(!new Headers(init.headers).get('Authorization'))throw Error('Missing Firebase identity')
  throw Error('測試：授權服務暂時無法使用，請稍後重試')
 }
 return originalFetch(url,init)
}
function Fixture(){
 const [loaded,setLoaded]=useState(false)
 return <><nav style={{padding:8}}><button onClick={async()=>{await loadAnnualCalendars();setLoaded(true)}}>載入官方年度資料</button></nav>
 {loaded&&<div style={{padding:'8px 12px'}}><p>FOMC 已涵蓋：{FOMC_COVERED_YEARS.join('、')}；交割已涵蓋：{TWSE_SETTLEMENT_COVERED_YEARS.join('、')}</p><p>2027 FOMC：{FOMC_DATES.filter(v=>v.date.startsWith('2027')).length} 筆</p><AnnualDataNotice fomcRange={{start:'2027-01-01',end:'2027-12-31'}} settlementRange={{start:'2027-01-01',end:'2027-12-31'}} /></div>}
 <CalendarSettings/><output style={{padding:8,display:'block'}}>測試寫入：{state.log.filter(row=>row.startsWith('set ')).length}</output></>
}
if(new URLSearchParams(location.search).has('settings')){
 await loadAnnualCalendars()
 createRoot(document.getElementById('root')).render(<CalendarSettings/> )
}else createRoot(document.getElementById('root')).render(<Fixture/> )
