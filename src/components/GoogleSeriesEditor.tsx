import { confirmAction } from '../ui/dialogs'
import { useEffect, useState } from 'react'
import { seriesRequest, refreshGoogleSeries, type GoogleSeries } from '../lib/googleSeries'
import { useSafeMutation } from '../lib/useSafeMutation'
import { captureUserSession } from '../lib/userDB'
import { simpleRule, weekdays } from '../lib/recurrenceRules'

const style = { padding: 8, background: 'var(--c-bg)', color: 'var(--c-text)', border: '1px solid var(--c-border)', borderRadius: 6 }
export default function GoogleSeriesEditor({ seriesId, onClose, onRefreshed }: { seriesId: string; onClose: () => void; onRefreshed: () => void }) {
    const [master, setMaster] = useState<GoogleSeries | null>(null)
    const [text, setText] = useState('')
    const [simple, setSimple] = useState<ReturnType<typeof simpleRule>>(null)
    const [error, setError] = useState('')
    const [notice, setNotice] = useState('')
    const [reviewedRules, setReviewedRules] = useState<string | null>(null)
    const [attempt, setAttempt] = useState(0)
    const [loadedAttempt, setLoadedAttempt] = useState(-1)
    const loading = loadedAttempt !== attempt
    const mutation = useSafeMutation()
    useEffect(() => {
        let active = true
        const session = captureUserSession()
        void seriesRequest<GoogleSeries>('read', seriesId, {}, session).then(row => {
            if (!active) return
            setMaster(row); setText(row.recurrence.join('\n')); setSimple(simpleRule(row.recurrence)); setError('')
        }).catch(reason => { if (active) { setError(reason instanceof Error ? reason.message : '系列讀取失敗'); setMaster(null) } }).finally(() => { if (active) setLoadedAttempt(attempt) })
        return () => { active = false }
    }, [seriesId, attempt])
    const rules = simple ? [`RRULE:FREQ=${simple.frequency};INTERVAL=${simple.interval}${simple.frequency === 'WEEKLY' && simple.days.length ? `;BYDAY=${simple.days.join(',')}` : ''}${simple.count ? `;COUNT=${simple.count}` : ''}`] : text.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
    const refresh = async () => mutation.run(async session => {
        await refreshGoogleSeries(seriesId, session)
        session.assertActive(); setNotice('整組行程已刷新。'); onRefreshed()
    })
    const save = async () => {
        if (!master || loading) return
        if (simple && (!/^\d+$/.test(simple.interval) || Number(simple.interval) < 1 || Number(simple.interval) > 999 || simple.count && (!/^\d+$/.test(simple.count) || Number(simple.count) < 1 || Number(simple.count) > 9999))) { setError('間隔需為 1–999；次數需為 1–9999 或留空。'); return }
        if (reviewedRules !== rules.join('\n')) { setReviewedRules(rules.join('\n')); return }
        await mutation.run(async session => {
            setError(''); setNotice(''); setReviewedRules(null)
            const updated = await seriesRequest<GoogleSeries>('update', seriesId, { etag: master.etag, recurrence: rules }, session)
            setMaster(updated); setNotice('Google 規則已保存，正在刷新行程；刷新失敗可按「刷新整組行程」重試。')
            await refreshGoogleSeries(seriesId, session)
            session.assertActive(); setNotice('整組規則已保存並刷新。'); onRefreshed()
        })
    }
    return <div role="dialog" aria-modal="true" aria-label="編輯整組重複規則" style={{ position: 'fixed', inset: 0, zIndex: 250, background: '#000a', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
        <section style={{ background: 'var(--c-sidebar)', color: 'var(--c-text)', padding: 24, borderRadius: 12, width: '100%', maxWidth: 600, maxHeight: '90vh', overflowY: 'auto' }}>
            <h2>編輯整組重複規則</h2>
            <p>{master?.summary || '讀取系列…'}</p>
            <p>修改系列的頻率與結束條件。系列原始起始日期、時間、時區及其他內容保持原值；每月／每年的日期由原始起始日期決定。</p>
            {master && <p>系列起點：{master.start.date || master.start.dateTime} {master.start.timeZone || ''}</p>}
            <fieldset disabled={loading || mutation.busy || !master} style={{ border: 0, padding: 0 }}>
                {simple ? <div style={{ display: 'grid', gap: 12 }}>
                    <label>頻率 <select style={style} value={simple.frequency} onChange={e => setSimple({ ...simple, frequency: e.target.value })}>{[['DAILY', '每天'], ['WEEKLY', '每週'], ['MONTHLY', '每月'], ['YEARLY', '每年']].map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
                    <label>每隔幾個週期 <input style={style} type="number" min="1" max="999" value={simple.interval} onChange={e => setSimple({ ...simple, interval: e.target.value })} /></label>
                    {simple.frequency === 'WEEKLY' && <div>星期（未勾選時沿用系列起始日）：{weekdays.map(([code, label]) => <label key={code} style={{ marginRight: 8 }}><input type="checkbox" checked={simple.days.includes(code)} onChange={e => setSimple({ ...simple, days: e.target.checked ? [...simple.days, code] : simple.days.filter(day => day !== code) })} />{label}</label>)}</div>}
                    <label>系列總次數（含已發生次數，留空表示持續）<input style={style} type="number" min="1" max="9999" value={simple.count} onChange={e => setSimple({ ...simple, count: e.target.value })} /></label>
                    <button onClick={() => { setText(rules.join('\n')); setSimple(null) }}>進階：截止日期與例外日期</button>
                </div> : <div><p>此模式保留完整規則。每行一條 RRULE、RDATE 或 EXDATE；UNTIL 與 COUNT 不可同時使用。日期型全天事件使用 YYYYMMDD；有時間事件的 UNTIL 使用 UTC（YYYYMMDDTHHMMSSZ）。</p><label>完整重複規則<textarea aria-label="完整重複規則" style={{ ...style, width: '100%', minHeight: 120 }} value={text} onChange={e => setText(e.target.value)} /></label><button onClick={() => { const parsed = simpleRule(rules); if (parsed) setSimple(parsed); else setError('此規則含截止日或複雜例外，請使用進階編輯，避免遺失原設定。') }}>切換簡易編輯</button></div>}
                <p>套用後：{simple ? `每隔 ${simple.interval} ${({ DAILY: '天', WEEKLY: '週', MONTHLY: '月', YEARLY: '年' } as Record<string, string>)[simple.frequency]}${simple.frequency === 'WEEKLY' && simple.days.length ? `，星期${simple.days.map(day => weekdays.find(([code]) => code === day)?.[1]).join('、')}` : ''}，${simple.count ? `系列共 ${simple.count} 次` : '持續重複'}` : rules.join(' ／ ')}</p>
                {reviewedRules === rules.join('\n') && <p role="status">即將修改「{master?.summary}」整個系列，包含過去及未來的正常次數；單次例外依 Google 的系列規則處理。請確認上方規則後套用。</p>}
                <button onClick={() => void save()}>{reviewedRules === rules.join('\n') ? '確認套用到整組' : '儲存整組規則'}</button>
                <button onClick={() => void refresh()}>刷新整組行程</button>
            </fieldset>
            {(error || mutation.error) && <p role="alert">{error || mutation.error}</p>}
            {notice && <p role="status">{notice}</p>}
            <button disabled={mutation.busy || loading} onClick={async () => { if (!await confirmAction('重新讀取會捨棄未儲存的規則，是否繼續？')) return; setAttempt(n => n + 1) }}>重新讀取規則</button>
            <button disabled={mutation.busy} onClick={onClose}>關閉</button>
        </section>
    </div>
}
