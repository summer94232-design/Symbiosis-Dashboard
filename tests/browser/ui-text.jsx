import DialogHost from '../../src/components/DialogHost'
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import InvestSettings from '../../src/pages/invest/InvestSettings'
import YearReview from '../../src/pages/invest/YearReview'
import PortfolioPlanner from '../../src/pages/invest/PortfolioPlanner'
import { ChainView } from '../../src/pages/invest/IndustryChainView'
import KMSExport from '../../src/pages/kms/KMSExport'
import KMSGraph from '../../src/pages/kms/KMSGraph'
import BrokerReconciliation from '../../src/pages/invest/BrokerReconciliation'
import CashFlow from '../../src/pages/invest/CashFlow'
import MarginManager from '../../src/pages/invest/MarginManager'
import Dividend from '../../src/pages/invest/Dividend'
import Dashboard from '../../src/pages/invest/Dashboard'
import Holdings from '../../src/pages/invest/Holdings'
import HistoryPnL from '../../src/pages/invest/HistoryPnL'
import Trades from '../../src/pages/invest/Trades'
import AssetTrend from '../../src/pages/invest/AssetTrend'
import SentimentTracker from '../../src/pages/invest/SentimentTracker'
import SoldTracker from '../../src/pages/invest/SoldTracker'
import IndustryMap from '../../src/pages/invest/IndustryMap'
import CalendarHome from '../../src/pages/calendar/CalendarHome'
import CalendarSettings from '../../src/pages/calendar/CalendarSettings'
import { applyTheme } from '../../src/theme'
import { invalidateAllInvestData } from '../../src/lib/investData'
import { InvestSyncProvider, InvestSyncStatus } from '../../src/InvestSyncContext.tsx'
import { investAuth, state, installNetworkFixture } from './services.mjs'
import '../../src/index.css'

installNetworkFixture()
investAuth.onAuthStateChanged = callback => { callback(investAuth.currentUser); return () => {} }
state.rows.set('users/fixture-A/cashflow/deposit', { date: '2026-09-01', type: 'in', amount: 200000 })
state.rows.set('users/fixture-A/trades/buy', { date: '2026-09-02', type: 'buy', code: '2330', name: '示範股票', shares: 1000, price: 100, fee: 143, tax: 0, total: 100143, isMargin: true, marginAmount: 60000 })
for (const [date, value] of [['2026-09-01',200000],['2026-09-30',205000]]) state.rows.set(`users/fixture-A/assetSnapshots/${date}`, { date, totalAssets: value, marketValue: 100000, cash: value - 100000, valuationBasis: 'closing' })
state.rows.set('users/fixture-A/settings/prices', { '2330': 105, _date: '2026-09-30' })
if (new URLSearchParams(location.search).get('case') === 'snapshot-trend') {
    state.rows.clear()
    state.network = 'snapshot-trend'
    state.rows.set('users/fixture-A/cashflow/deposit',{date:'2026-10-01',type:'in',amount:100000})
    state.rows.set('users/fixture-A/trades/buy',{date:'2026-10-01',code:'2330',name:'隔離測試股票',type:'buy',shares:100,price:100,total:10000,fee:0,tax:0})
    for (const [date,totalAssets,valuationQuality] of [['2026-10-01',100000,undefined],['2026-10-02',102000,'intraday'],['2026-10-05',101000,'manual-unverified']]) {
        state.rows.set(`users/fixture-A/assetSnapshots/${date}`,{date,totalAssets,marketValue:totalAssets-90000,cash:90000,marginDebt:0,...(valuationQuality?{valuationQuality}:{})})
    }
}
// Isolated in-memory UI fixture: exercise errors and repair of legacy credit dividends.
if (new URLSearchParams(location.search).get('audit') === 'legacy-margin') {
    const buy = state.rows.get('users/fixture-A/trades/buy')
    state.rows.set('users/fixture-A/trades/buy', { ...buy, total: 40143 })
    state.rows.set('users/fixture-A/dividends/legacy', { date: '2026-09-03', stockDistributionDate: '2026-09-04', code: '2330', name: '示範股票', status: 'confirmed', stockDividend: 100, cashDividend: 0 })
    state.rows.set('users/fixture-A/trades/legacy-sell', { date: '2026-09-05', type: 'sell', code: '2330', name: '示範股票', shares: 1100, price: 100, fee: 0, tax: 0, total: 50000, isMargin: true, marginRepay: 60000, marginPrincipal: 60000, marginInterest: 0 })
}
const pages = [
    ['dashboard','儀表板',Dashboard],
    ['holdings','持倉明細',Holdings],['history','歷史損益',HistoryPnL],['trades','買賣紀錄',Trades],
    ['settings','設定與備份',InvestSettings],['review','年度復盤',YearReview],['planner','組合水位試算',PortfolioPlanner],
    ['industry','產業脈絡圖',()=> <ChainView nodes={[{code:'2330',name:'示範股票'}]}/>],['export','知識庫匯出',KMSExport],['graph','知識圖譜',KMSGraph],
    ['broker','對帳核對',BrokerReconciliation],['cash','出入金',CashFlow],['margin','融資管理',MarginManager],['dividend','除權息',Dividend],
    ['trend','資產趨勢',AssetTrend],['sentiment','觀點追蹤',SentimentTracker],['sold','賣出追蹤',SoldTracker],
    ['industry-map','產業地圖',IndustryMap],['calendar','月曆',CalendarHome],['calendar-settings','行事曆設定',CalendarSettings],
]
function Fixture() {
    const [page,setPage] = useState(new URLSearchParams(location.search).get('page') || 'export')
    const Component = pages.find(([key]) => key === page)?.[2] || KMSExport
    const [theme, setTheme] = useState('dark')
    const [holdingReads, setHoldingReads] = useState(false)
    return <MemoryRouter><InvestSyncProvider><div style={{display:'flex',flexDirection:'column',height:'100dvh'}}>
        <nav style={{ padding: '8px 10px', borderBottom: '1px solid var(--c-border)', display:'flex', alignItems:'center', gap:8, flexWrap:'wrap' }}><label style={{ fontSize:12 }}>預覽 <select aria-label="預覽頁面" value={page} onChange={event=>setPage(event.target.value)} style={{maxWidth:120}}>{pages.map(([key,name])=><option key={key} value={key}>{name}</option>)}</select></label>
            <select aria-label="預覽色彩" value={theme} onChange={event=>{setTheme(event.target.value);applyTheme(event.target.value)}}><option value="dark">深色</option><option value="light">淺色</option></select>
            <button style={{fontSize:11}} onClick={()=>{state.holdReads=!holdingReads;setHoldingReads(!holdingReads);invalidateAllInvestData();if(holdingReads)state.pendingReads.splice(0).forEach(resolve=>resolve())}}>{holdingReads?'完成讀取':'延後讀取'}</button>
        </nav>
        <DialogHost scope={page}/><main className="app-main" style={{flex:1,minHeight:0,overflowY:'auto'}}><InvestSyncStatus /><Component key={page}/></main>
        <output data-testid="fixture-writes" style={{padding:8,fontSize:12,display:'block'}}>測試寫入：{state.log.filter(row=>/^(set|update|delete) /.test(row)).length}</output>
    </div></InvestSyncProvider></MemoryRouter>
}
createRoot(document.getElementById('root')).render(<Fixture/> )
