import { lazy, Suspense, useState } from 'react'
import { createRoot } from 'react-dom/client'
import AppErrorBoundary from '../../src/components/AppErrorBoundary'
import AnnualDataNotice from '../../src/components/AnnualDataNotice'
import CalendarHome from '../../src/pages/calendar/CalendarHome'
import { installNetworkFixture } from './services.mjs'

installNetworkFixture()
const FailedLazyPage = lazy(() => Promise.reject(Error('isolated lazy loading failure')))
function BrokenPage() { throw Error('isolated rendering failure') }
function Harness() {
    const [page, setPage] = useState('normal'), [year, setYear] = useState('2026')
    return <><style>{`:root{--c-bg:#14182a;--c-card:#1c2235;--c-sidebar:#0f1220;--c-text:#dde2f0;--c-muted:#7a88aa;--c-border:#2a3050;--c-accent:#8b9ef5;--c-warning:#d8ad51}body{margin:0;font-family:system-ui;background:var(--c-bg);color:var(--c-text)}button,input{font:inherit}nav{display:flex;flex-wrap:wrap;gap:8px;padding:12px}nav button{padding:8px;min-height:44px}main{padding:12px}`}</style>
        <nav aria-label="測試側欄">
            <button onClick={() => setPage('normal')}>正常頁面</button>
            <button onClick={() => setPage('broken')}>模擬頁面錯誤</button>
            <button onClick={() => setPage('lazy')}>模擬載入失敗</button>
            <button onClick={() => setPage('global')}>模擬全域錯誤</button>
            <button onClick={() => setPage('calendar')}>實際月曆</button>
        </nav>
        {page === 'global' && <BrokenPage />}
        <main><AppErrorBoundary key={page} scope="page"><Suspense fallback={<p>載入中</p>}>
            {page === 'broken' ? <BrokenPage /> : page === 'lazy' ? <FailedLazyPage /> : page === 'calendar' ? <CalendarHome /> : <>
                <h1>正常頁面</h1>
                <label>年度 <input aria-label="年度" value={year} onChange={event => setYear(event.target.value)} /></label>
                <AnnualDataNotice fomcRange={{ start: `${year}-01-01`, end: `${year}-12-31` }} />
                <AnnualDataNotice settlementRange={{ start: `${year}-12-30`, end: `${year}-12-30` }} />
            </>}
        </Suspense></AppErrorBoundary></main>
    </>
}
createRoot(document.getElementById('root')).render(<AppErrorBoundary><Harness /></AppErrorBoundary>)
