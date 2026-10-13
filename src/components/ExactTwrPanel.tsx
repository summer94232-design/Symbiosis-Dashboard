import { confirmAction } from '../ui/dialogs'
import { useEffect, useState } from 'react'
import { getDocsFromServer, getDocFromServer } from 'firebase/firestore'
import { investDB } from '../lib/firebase'
import { captureUserSession } from '../lib/userDB'
import { useSafeMutation } from '../lib/useSafeMutation'
import { useInvestSync } from '../InvestSyncContext'
import { calculateExactTwr, isExactTwrReport, ledgerSignature, type ExactTwrReport, type TwrFlow } from '../lib/exactTwr'
import { toLocalDateString } from '../lib/date'
import { saveExactTwrReport } from '../lib/exactTwrStore'

const blank = (): ExactTwrReport => ({ startDate: '', endDate: toLocalDateString(), startValue: '', endValue: '', startSource: '', endSource: '', valuations: {}, ledgerSignature: '' })
const inputStyle = { padding: 8, border: '1px solid var(--c-border)', borderRadius: 6, background: 'var(--c-bg)', color: 'var(--c-text)', width: '100%', boxSizing: 'border-box' as const }
async function readLedger(session: ReturnType<typeof captureUserSession>) {
    const collections = await Promise.all(['cashflow', 'trades', 'dividends'].map(name => getDocsFromServer(session.col(investDB, name))))
    session.assertActive()
    const rows = collections.map(collection => collection.docs.map(d => ({ ...d.data(), id: d.id })).sort((a, b) => a.id.localeCompare(b.id)))
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ledgerSignature(rows)))
    session.assertActive()
    return { flows: rows[0] as TwrFlow[], signature: [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('') }
}

export default function ExactTwrPanel() {
    const { version } = useInvestSync()
    const [report, setReport] = useState<ExactTwrReport | null>(null)
    const [baseline, setBaseline] = useState('')
    const [flows, setFlows] = useState<TwrFlow[]>([])
    const [signature, setSignature] = useState('')
    const [error, setError] = useState('')
    const [loadedKey, setLoadedKey] = useState('')
    const [reload, setReload] = useState(0)
    const [saved, setSaved] = useState(false)
    const mutation = useSafeMutation()
    const ready = loadedKey === `${version}/${reload}`
    useEffect(() => {
        let active = true
        const session = captureUserSession()
        void Promise.all([readLedger(session), getDocFromServer(session.doc(investDB, 'settings', 'exactTwr'))]).then(([ledger, snapshot]) => {
            session.assertActive()
            if (!active) return
            setFlows(ledger.flows); setSignature(ledger.signature)
            const stored = snapshot.exists() ? snapshot.data().report : blank()
            if (!isExactTwrReport(stored)) throw new Error('已保存的估值格式無效，請先檢查備份或修復該估值紀錄。')
            // Keep unsaved form changes when another device changes the ledger.
            setReport(previous => previous || stored)
            setBaseline(previous => previous || ledgerSignature(snapshot.exists() ? snapshot.data() : null))
            setError(''); setLoadedKey(`${version}/${reload}`)
        }).catch(reason => { if (active) { setError(reason instanceof Error ? reason.message : '估值資料讀取失敗'); setLoadedKey('') } })
        return () => { active = false }
    }, [version, reload])
    useEffect(() => {
        const offline = () => setLoadedKey('')
        const online = () => setReload(value => value + 1)
        window.addEventListener('offline', offline); window.addEventListener('online', online)
        return () => { window.removeEventListener('offline', offline); window.removeEventListener('online', online) }
    }, [])
    const update = (patch: Partial<ExactTwrReport>) => { setSaved(false); setReport(previous => previous ? { ...previous, ...patch, ledgerSignature: '' } : previous) }
    const result = report ? calculateExactTwr(report, flows) : null
    const periodEnded = !!report && report.endDate < toLocalDateString()
    const verified = ready && periodEnded && report?.ledgerSignature === signature
    const selected = report ? flows.filter(f => f.date > report.startDate && f.date <= report.endDate).sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id)) : []
    const save = async () => {
        if (!report || !ready || !periodEnded || result?.percent == null) return
        await mutation.run(async session => {
            const latest = await readLedger(session)
            if (latest.signature !== signature) throw new Error('帳本已變更，請重新讀取並核對估值後再保存。')
            const confirmed = { ...report, ledgerSignature: signature }
            const committed = await saveExactTwrReport(confirmed, baseline, session)
            session.assertActive()
            setReport(confirmed); setBaseline(ledgerSignature(committed)); setSaved(true)
        })
    }
    return <section style={{ marginBottom: 24, padding: 20, border: '1px solid var(--c-border)', borderRadius: 12 }}>
        <h2 style={{ marginTop: 0 }}>精確 TWR</h2>
        <p>以日終淨值作為區間端點，逐筆出入金前估值切段連乘。淨值須包含全部持倉及現金、扣除融資負債；股利與買賣留在帳戶內，不另當成出入金。</p>
        <p>請填入實際估值與依據，不能用今日報價代替歷史估值。此處保存計算依據，不修改帳本或歷史快照；目前保存最近一組區間。</p>
        <button disabled={mutation.busy} onClick={async () => { if (report && !await confirmAction('重新讀取會捨棄尚未保存的估值，是否繼續？')) return; setReport(null); setBaseline(''); setSaved(false); setReload(n => n + 1) }}>重新讀取估值與帳本</button>
        {!ready && <p role="status">尚未取得完整伺服器資料，計算結果暫不顯示。</p>}
        {(error || mutation.error) && <p role="alert">{error || mutation.error}</p>}
        {report && <fieldset disabled={mutation.busy || !ready} style={{ border: 0, padding: 0 }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12, marginTop: 16 }}>
                {(['start', 'end'] as const).map(key => <div key={key}>
                    <label>{key === 'start' ? '期初' : '期末'}日期（日終）<input aria-label={`${key === 'start' ? '期初' : '期末'}日期`} type="date" style={inputStyle} value={report[`${key}Date`]} onChange={e => update({ [`${key}Date`]: e.target.value })} /></label>
                    <label>帳戶淨值<input aria-label={`${key === 'start' ? '期初' : '期末'}淨值`} type="number" step="any" style={inputStyle} value={report[`${key}Value`]} onChange={e => update({ [`${key}Value`]: e.target.value })} /></label>
                    <label>估值依據<input aria-label={`${key === 'start' ? '期初' : '期末'}估值依據`} maxLength={500} placeholder="例如：當日券商帳戶報表" style={inputStyle} value={report[`${key}Source`]} onChange={e => update({ [`${key}Source`]: e.target.value })} /></label>
                </div>)}
            </div>
            <p>需估值的出入金：{selected.length} 筆。期初當日已包含於期初日終淨值；期末當日出入金仍須逐筆估值。時間採台北時間。</p>
            {selected.map(flow => {
                const valuation = Object.hasOwn(report.valuations, flow.id) ? report.valuations[flow.id] : { time: '', before: '', source: '', order: '1' }
                const change = (patch: Partial<typeof valuation>) => update({ valuations: { ...report.valuations, [flow.id]: { ...valuation, ...patch } } })
                const after = valuation.before.trim() ? Number(valuation.before) + (flow.type === 'in' ? flow.amount : -flow.amount) : null
                return <div key={flow.id} style={{ padding: 12, borderTop: '1px solid var(--c-border)' }}>
                    <strong>{flow.date} {flow.type === 'in' ? '入金' : '出金'} {flow.amount.toLocaleString()}</strong>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 8 }}>
                        <label>發生時間（含秒）<input type="time" step="1" style={inputStyle} value={valuation.time} onChange={e => change({ time: e.target.value.length === 5 ? e.target.value + ':00' : e.target.value })} /></label>
                        <label>同秒先後順序<input type="number" min="1" step="1" style={inputStyle} value={valuation.order || '1'} onChange={e => change({ order: e.target.value })} /></label>
                        <label>出入金前帳戶淨值<input type="number" step="any" style={inputStyle} value={valuation.before} onChange={e => change({ before: e.target.value })} /></label>
                        <label>當時估值依據<input maxLength={500} style={inputStyle} value={valuation.source} onChange={e => change({ source: e.target.value })} /></label>
                    </div>
                    <small>流量後淨值（流量前淨值加減本筆金額）：{after == null ? '—' : after.toLocaleString()}</small>
                </div>
            })}
            {ready && result?.issues.map(issue => <p key={issue} role="status">{issue}</p>)}
            {!verified && <p>請核對並確認估值。帳本異動後必須重新確認，未確認的數值不標示為精確報酬。</p>}
            {!periodEnded && <p>期末日尚未結束，請選擇昨天或更早的日終估值。</p>}
            <button disabled={!periodEnded || result?.percent == null} onClick={() => void save()}>{mutation.busy ? '保存中…' : '確認估值依據並保存計算'}</button>
        </fieldset>}
        {verified && result?.percent != null && <div role="status">
            <h3>區間精確 TWR：{result.percent.toFixed(4)}%（未年化）</h3>
            <p>依已確認估值計算；估值品質仍取決於填入資料。{saved ? '已保存。' : ''}</p>
            <div style={{ overflowX: 'auto' }}><table><thead><tr><th>子期間終點</th><th>起始淨值</th><th>流量前／期末淨值</th><th>外部流量</th><th>流量後淨值</th><th>子期間報酬</th></tr></thead><tbody>
                {result.segments.map(segment => <tr key={segment.label}><td>{segment.label}</td><td>{segment.opening.toLocaleString()}</td><td>{segment.closing.toLocaleString()}</td><td>{segment.flow.toLocaleString()}</td><td>{segment.after.toLocaleString()}</td><td>{segment.returnPercent.toFixed(4)}%</td></tr>)}
            </tbody></table></div>
        </div>}
    </section>
}
