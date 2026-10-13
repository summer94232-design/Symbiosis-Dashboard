import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { BookOpen, ExternalLink, RefreshCw, X } from 'lucide-react'
import { investAuth } from '../lib/auth'
import { fetchMarketReports, type MarketReportFeed } from '../lib/marketReports'
import { reportDeliveryStatus } from '../../netlify/lib/market-reports.js'
import AiMarkdown from './AiMarkdown'
import '../ui/ai.css'
import '../ui/market-reports.css'

export default function MarketReportCard() {
    const [feed, setFeed] = useState<MarketReportFeed | null>(null)
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState('')
    const [reconnect, setReconnect] = useState(false)
    const [open, setOpen] = useState(false)
    const [now, setNow] = useState(() => new Date())
    const dialog = useRef<HTMLDialogElement>(null)
    const request = useRef<{ abort: AbortController; generation: number } | null>(null)
    const selection = useRef<string | undefined>(undefined)
    const load = useCallback(async (refresh = false, report?: string) => {
        request.current?.abort.abort()
        const current = { abort: new AbortController(), generation: (request.current?.generation || 0) + 1 }
        request.current = current
        setLoading(true)
        try {
            const result = await fetchMarketReports({ refresh, report, signal: current.abort.signal })
            if (request.current !== current || current.abort.signal.aborted) return
            setFeed(result); setError(''); setReconnect(false)
        } catch (failure) {
            if (request.current !== current || current.abort.signal.aborted) return
            setError(failure instanceof Error ? failure.message : '報告讀取失敗')
            setReconnect(Boolean((failure as { reconnect?: boolean }).reconnect))
        } finally { if (request.current === current && !current.abort.signal.aborted) setLoading(false) }
    }, [])
    useEffect(() => {
        const unsubscribe = investAuth.onAuthStateChanged(() => {
            request.current?.abort.abort(); setFeed(null); setOpen(false); selection.current = undefined
            void load()
        })
        const focus = () => { if (document.visibilityState === 'visible') void load(false, selection.current) }
        const polling = setInterval(focus, 300000)
        const clock = setInterval(() => setNow(new Date()), 30000)
        window.addEventListener('focus', focus)
        return () => { unsubscribe(); request.current?.abort.abort(); clearInterval(polling); clearInterval(clock); window.removeEventListener('focus', focus) }
    }, [load])
    useEffect(() => {
        if (open && dialog.current && !dialog.current.open) dialog.current.showModal()
        if (!open && dialog.current?.open) dialog.current.close()
    }, [open])
    const visibleFeed = feed?.ownerUid === investAuth.currentUser?.uid ? feed : null
    const report = visibleFeed?.selected || visibleFeed?.latest
    const close = () => { selection.current = undefined; setOpen(false) }
    return <section className="market-report-card" aria-label="台股每日投資報告">
        <div className="market-report-header">
            <h2><BookOpen size={16} />台股每日投資報告</h2>
            <button className="ui-button ui-button-secondary" disabled={loading} onClick={() => void load(true, selection.current)}><RefreshCw size={14} className={loading ? 'is-spinning' : undefined} />{loading ? '讀取中' : '重新讀取'}</button>
        </div>
        {error && <p role="status" className="market-report-warning">{error}{visibleFeed ? '；保留上次讀取內容' : ''}</p>}
        {reconnect && <Link className="market-report-link" to="/calendar/settings">前往行事曆設定補充授權</Link>}
        {visibleFeed ? <>
            <p className="market-report-status">{reportDeliveryStatus(visibleFeed.latest, visibleFeed.reports, now, visibleFeed.holidays, Boolean(error))}</p>
            {(visibleFeed.source.fallback || visibleFeed.source.invalidRows > 0) && <p className="market-report-warning">{visibleFeed.source.fallback ? '最新新表尚未完整，已使用上一份可閱讀試算表。' : ''}{visibleFeed.source.invalidRows > 0 ? `已略過 ${visibleFeed.source.invalidRows} 筆不完整或尚未到期的資料。` : ''}</p>}
            <h3>{visibleFeed.latest.title}</h3>
            <p className="market-report-summary">{visibleFeed.latest.summary}</p>
            <div className="market-report-footer">
                <span>更新：{visibleFeed.latest.updatedAt}</span>
                <button className="ui-button ui-button-primary" onClick={() => { selection.current = undefined; setFeed({ ...visibleFeed, selected: null }); setOpen(true) }}>閱讀全文</button>
            </div>
        </> : !error && <p className="market-report-status">{loading ? '正在搜尋最新報告…' : '尚無可閱讀報告'}</p>}
        <dialog ref={dialog} className="market-report-dialog" aria-labelledby="market-report-title" onCancel={close} onClose={close}>
            {report && <>
                <div className="market-report-dialog-header"><h2 id="market-report-title">{report.title}</h2><button className="ui-button ui-button-secondary" aria-label="關閉報告" onClick={close}><X size={18} /></button></div>
                <div className="market-report-toolbar">
                    <select aria-label="選擇歷史報告" value={report.id} disabled={loading} onChange={event => { selection.current = event.target.value; void load(false, event.target.value) }}>
                        {visibleFeed?.reports.map(item => <option key={item.id} value={item.id}>{item.date} {item.period} · {item.title}</option>)}
                    </select>
                    <a className="market-report-link" href={`https://docs.google.com/spreadsheets/d/${visibleFeed?.source.id}/edit`} target="_blank" rel="noopener noreferrer"><ExternalLink size={14} />原始試算表</a>
                </div>
                {error && <p role="status" className="market-report-warning">{error}</p>}
                <div className="market-report-content"><p className="market-report-status">{report.date} {report.period} · 更新 {report.updatedAt}</p><AiMarkdown text={report.content} /></div>
            </>}
        </dialog>
    </section>
}
