import { memo, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { Check, Copy, FilePlus2, MessageCircle, Minus, Send, X } from 'lucide-react'
import { aiSession, type AiMessage } from '../lib/aiSession'
import { alertAction, confirmAction } from '../ui/dialogs'
import { authenticatedFetch } from '../lib/authenticatedFetch'
import { invalidateKmsNotes } from '../lib/kmsData'
import { captureUserSession } from '../lib/userDB'
import AiMarkdown from './AiMarkdown'
import '../ui/ai.css'

const validLink = (url: string) => { try { const u = new URL(url); return ['https:','http:'].includes(u.protocol) ? u.href : '' } catch { return '' } }
const Message = memo(function Message({ message, onSave, onPreference, onResearch, busy }: { message: AiMessage; onSave: (m: AiMessage) => void; onPreference: (text: string) => void; onResearch?:(token:string)=>void; busy?:boolean }) {
    const reply = message.reply
    const answerRef = useRef<HTMLDivElement>(null)
    const readableContent = () => {
        const element = answerRef.current
        if (!element) return message.content
        const text = element.innerText, seen = new Set<string>()
        const links = [...element.querySelectorAll<HTMLAnchorElement>('a[href]')].map(a => ({ title: a.innerText, url: validLink(a.href) }))
            .concat((reply?.citations || []).map(c => ({ title: c.title, url: validLink(c.url) })))
            .filter(link => { if (!link.url || text.includes(link.url) || seen.has(link.url)) return false; seen.add(link.url); return true })
        return text + (links.length ? '\n\n' + links.map(link => `${link.title || '來源'}：${link.url}`).join('\n') : '')
    }
    return <article className={`ai-message ai-${message.role}`} aria-label={message.role === 'user' ? '你的訊息' : 'AI 回答'}>
        <div className="ai-message-label">{message.role === 'user' ? '你' : 'AI 助理'}</div>
        {reply?.currentFactsRequested && !reply.webVerified && <p className="ai-warning">本輪未取得可核對的網頁來源，現況與投資結論仍待查證。</p>}
        <div className="ai-answer" ref={answerRef}>{message.role === 'assistant' ? <AiMarkdown text={message.content} /> : message.content}</div>
        {reply?.partial && !reply.research?.reason && <p className="ai-warning">{reply.recovery || '答案未完整結束，可能已達輸出上限。可手動追問。'}</p>}
        {reply && <>
            <div className="ai-source-summary">{reply.scope.scanned > 0 ? `搜尋 ${reply.scope.scanned} 則筆記，提供 ${reply.sources.length} 則相關摘錄` : reply.scope.reason || '本輪沒有搜尋筆記'}{reply.webVerified ? ` · 聯網 ${reply.webSearches} 次` : ''}</div>
            {!!reply.scope.unreadCandidates && <small>另有 {reply.scope.unreadCandidates} 則候選筆記尚未讀取，本輪並未涵蓋所有紀錄。</small>}
            {reply.scope.totalChunks !== undefined && <div className="ai-reading-progress">
                <span>已讀 {reply.scope.summarizedChunks}/{reply.scope.totalChunks} 段 · {(reply.scope.readCharacters || 0).toLocaleString()}/{(reply.scope.totalCharacters || 0).toLocaleString()} 字</span>
                {!!reply.scope.reusedChunks && <small>重用 {reply.scope.reusedChunks} 段已核對版本的摘要</small>}
                {!reply.research?.synthesisPending && (reply.scope.includedSummaryChunks || 0) < (reply.scope.summarizedChunks || 0) && <small>本輪提供 {reply.scope.includedSummaryChunks} 段摘要；其餘已讀摘要保留於本機。</small>}
            </div>}
            {reply.research && <div className="ai-reading-actions">
                {reply.research.canContinue && <button disabled={busy} onClick={()=>onResearch?.(reply.research!.token)}>{reply.research.offer ? `完整整理（這項研究最高 NT$${reply.research.limitTwd}）` : reply.research.synthesisPending && reply.scope.summarizedChunks === reply.scope.totalChunks ? '重試綜合回答' : '繼續整理'}</button>}
                {reply.research.offer && <small>最多 24 則候選筆記分段閱讀；到達預算即停止，未讀範圍會列出。</small>}
                {!reply.research.offer && <small>研究累積 NT${reply.research.costTwd.toFixed(3)} / {reply.research.limitTwd} · {reply.research.complete ? '已讀完選定範圍' : '部分閱讀'}{reply.research.reason ? ` · ${reply.research.reason}` : reply.research.synthesisPending ? ' · 綜合回答未完成' : ''}</small>}
            </div>}
            {reply.sources.length > 0 && <details className="ai-evidence"><summary>筆記來源與段落</summary>
                {reply.sources.map(source => <div key={source.id} className="ai-source">
                    <a href={`/kms?note=${encodeURIComponent(source.id)}`}>[{source.ref}] {source.title}</a>
                    <small>儲存：{source.savedAt?.slice(0,10) || '未知'} · 修改：{source.updatedAt?.slice(0,10) || '未知'}（不是來源／查證日期）</small>
                    {source.passages.map((p,index) => <blockquote key={`${p.paragraph}-${index}`}>第 {p.paragraph} 段：{p.quote}</blockquote>)}
                </div>)}
                <small>提供本輪檢索取得的部分段落；內容不足時仍需核對原筆記，可在設定中指定搜尋範圍。</small>
            </details>}
            {reply.citations.length > 0 && <div className="ai-web-sources" aria-label="網頁來源">{reply.citations.filter(c => validLink(c.url)).map((c,i) => <a key={`${c.url}/${i}`} href={validLink(c.url)} target="_blank" rel="noopener noreferrer">{c.title}</a>)}</div>}
            {reply.searchSuggestions && <iframe title="Google 搜尋建議" className="ai-search-suggestions" sandbox="allow-popups" srcDoc={reply.searchSuggestions} />}
            {reply.preference?.kind === 'candidate' && <button className="ai-subtle" onClick={() => onPreference(reply.preference!.text)}>記住這項互動偏好：{reply.preference.text}</button>}
            {reply.preference?.kind === 'explicit' && <small>已記住互動偏好：{reply.preference.text}</small>}
            {reply.billingPending && <small>本輪費用待核對，仍保留預留額度。</small>}
            {reply.usage && <details className="ai-evidence"><summary>本輪用量 · {reply.costTwd === null ? '待核對' : `NT$${reply.costTwd.toFixed(3)}`}</summary>
                <small>輸入 {reply.usage.input.toLocaleString()} tokens（快取命中 {reply.usage.cached.toLocaleString()}）；生成 {(reply.usage.output-reply.usage.thoughts).toLocaleString()}，思考 {reply.usage.thoughts.toLocaleString()}。輸出費用包含思考；依實際命中計算快取折扣。</small>
            </details>}
        </>}
        {message.role === 'assistant' && <div className="ai-inline-actions">
            <button onClick={async () => { try { await navigator.clipboard.writeText(readableContent()) } catch { await alertAction('複製失敗，請選取文字後複製') } }}><Copy size={14} />複製</button>
            <button onClick={() => onSave({ ...message, content: readableContent() })}><FilePlus2 size={14} />存成新筆記</button>
            <button onClick={async () => { if (await confirmAction('將這則答案保留為目前討論重點，並清除本機較長的對話；相關筆記摘錄會一起保留。')) aiSession.keepSummary(readableContent()) }}>保留重點</button>
        </div>}
    </article>
})

export default function AiAssistantPanel({ onClose }: { onClose: () => void }) {
    const state = useSyncExternalStore(aiSession.subscribe, aiSession.getSnapshot)
    const navigate = useNavigate(), location = useLocation()
    const [settings, setSettings] = useState(false)
    const [preferences, setPreferences] = useState<string | null>(null)
    const [saving, setSaving] = useState(false)
    const [notice, setNotice] = useState('')
    const [note, setNote] = useState<{ id: string; title: string; content: string } | null>(null)
    const [viewUid, setViewUid] = useState(state.uid)
    if (viewUid !== state.uid) { setViewUid(state.uid); setNote(null); setPreferences(null); setNotice(''); setSettings(false) }
    const scrollRef = useRef<HTMLDivElement>(null)
    const inputRef = useRef<HTMLTextAreaElement>(null)
    useEffect(() => { void aiSession.loadStatus() }, [state.uid, state.statusAttempted])
    useEffect(() => { scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'instant' }) }, [state.messages.length, state.busy])
    useEffect(() => {
        const oldFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
        inputRef.current?.focus()
        return () => oldFocus?.focus()
    }, [])
    const savePreference = async (text?: string) => {
        setSaving(true); setNotice('')
        try {
            await aiSession.savePreferences(text ? [...new Set([...(state.status?.preferences?.items || []),text])] : (preferences ?? (state.status?.preferences?.items || []).join('\n')).split('\n').map(s => s.trim()).filter(Boolean))
            setNotice('偏好已同步')
        } catch (error) { setNotice(error instanceof Error ? error.message : '偏好儲存失敗') }
        finally { setSaving(false) }
    }
    const saveNote = async () => {
        if (!note || saving) return
        setSaving(true); setNotice('')
        try {
            const session = captureUserSession()
            if (session.uid !== state.uid) throw new Error('帳號已變更，請重新確認草稿')
            const response = await authenticatedFetch('/.netlify/functions/ai-assistant', session, { method: 'POST', headers: { 'Content-Type':'application/json' }, body: JSON.stringify({ action: 'note', ...note }) })
            const data = await response.json() as { noteId: string; budget?: NonNullable<typeof state.status>['budget'] }
            session.assertActive()
            if (data.budget) aiSession.applyBudget(data.budget, session.uid)
            invalidateKmsNotes(); setNote(null); setNotice('已建立新筆記')
            if (await confirmAction('新筆記已儲存，要開啟知識庫查看嗎？')) navigate(`/kms?note=${encodeURIComponent(data.noteId)}`)
        } catch (error) { setNotice(error instanceof Error ? error.message : '新筆記儲存失敗，內容仍保留') }
        finally { setSaving(false) }
    }
    const models = state.status?.config.models || []
    const statusReady = !!state.status && !state.statusLoading && !state.statusError
    const canSend = statusReady && models.some(m => m.id === state.model && m.available) && !state.busy && !!state.draft.trim()
    const budget = state.status?.budget
    return <section className="ai-panel" role="dialog" aria-label="AI 助理" aria-modal={false} onKeyDown={event => {
        if (event.key === 'Escape') { event.stopPropagation(); onClose() }
        if (event.key === 'Tab') {
            const items = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],input,select,textarea,summary')].filter(el => el.getClientRects().length)
            if (event.shiftKey && document.activeElement === items[0]) { event.preventDefault(); items.at(-1)?.focus() }
            else if (!event.shiftKey && document.activeElement === items.at(-1)) { event.preventDefault(); items[0]?.focus() }
        }
    }}>
        <header className="ai-header"><div className="ai-heading"><div className="ai-title"><MessageCircle size={17} /><strong>AI 助理</strong></div>
            <select className="ai-model-select" aria-label="AI 模型" title={models.find(m => m.id === state.model)?.label} value={state.status ? state.model : ''} disabled={state.busy || !statusReady} onChange={e => aiSession.setModel(e.target.value)}>{!state.status && <option value="">{state.statusError ? '設定載入失敗' : '載入模型中…'}</option>}{models.map(m => <option key={m.id} value={m.id} disabled={!m.available}>{m.label}{!m.available ? '（未啟用）' : ''}</option>)}</select>
            {state.busy && <span role="status">思考中</span>}</div>
            <div className="ai-inline-actions">
                <button aria-label="AI 設定與偏好" aria-expanded={settings} onClick={() => { setSettings(v => !v); setPreferences(null) }}>設定</button>
                <button title="清除目前對話" onClick={async () => { if (await confirmAction('開始新對話並清除這個裝置的目前對話？長期偏好仍會保留。')) { aiSession.clear(); setNote(null); setNotice('') } }}>新對話</button>
                <button aria-label="縮小 AI 視窗" onClick={onClose}><Minus size={17} /></button>
            </div>
        </header>
        {state.statusLoading && <p className="ai-notice" role="status">正在確認模型設定…</p>}
        {state.statusError && <div className="ai-error ai-status-error" role="alert"><span>AI 設定載入失敗：{state.statusError}</span><button disabled={state.busy || saving || !state.uid} onClick={() => void aiSession.loadStatus(true)}>重試連線</button></div>}
        {settings && <div className="ai-settings">
            <p>{!state.status ? '設定尚未載入，Google 帳號尚無法確認。' : state.status.google.verified ? <>Google：{state.status.google.account}<br />專案：{state.status.google.project}</> : 'Google 金鑰所屬帳號尚未核對'}</p>
            <p>兩個 Gemini 共用同一付費專案。只把相關文字傳給模型；目前對話只存本機，供應商仍可能依條款有限保存。</p>
            <p>完整整理以 Flash-Lite 做分段摘要，再以你選擇的模型綜合回答。中途可切換模型，共用原研究額度。摘要只在這個裝置保留 7 天，換頁或新對話仍可重用；修改筆記後會重新核對。</p>
            <p>費用上限：每月 NT${state.status?.config.monthlyTwd || 150}、每日 NT${state.status?.config.dailyTwd || 10}、一般問題 NT${state.status?.config.turnTwd || 1}；完整整理每項 NT${state.status?.config.researchTwd || 5}，分批共用額度。</p>
            <p>嚴格預算模式暫停自動聯網搜尋。Google 的內建搜尋沒有可設定的查詢次數上限；涉及最新現況時會標記待查證。</p>
            <label>指定筆記搜尋詞（可留空）<input aria-label="筆記搜尋詞" value={state.keyword} onChange={e => aiSession.setKeyword(e.target.value)} placeholder="例如：散熱、食譜" maxLength={80} /></label>
            <label>長期互動偏好（每行一項）<textarea aria-label="長期互動偏好" value={preferences ?? (state.status?.preferences?.items || []).join('\n')} onChange={e => setPreferences(e.target.value)} rows={3} /></label>
            <div className="ai-inline-actions"><button disabled={saving || !statusReady || !state.status?.preferences} onClick={() => void savePreference()}><Check size={14} />儲存偏好</button><button disabled={state.busy || saving || state.statusLoading} onClick={() => void aiSession.loadStatus(true)}>重新載入設定</button></div>
            <p>先按未命中快取的用量預留，再按實際用量結算。NT$150 管理本系統的模型費用；Google 帳號其他程式、稅金及匯率差額需由帳務後臺核對。{state.status && !state.status.config.quotaConfirmed && 'Firebase 實際額度待確認，目前使用保守的 AI 子額度。'}</p>
            {budget && <p>今日 AI 預留讀／寫：投資 {budget.daily.investReads}/{budget.limits.investReads} · {budget.daily.investWrites}/{budget.limits.investWrites}；知識庫 {budget.daily.kmsReads}/{budget.limits.kmsReads} · {budget.daily.kmsWrites}/{budget.limits.kmsWrites}。</p>}
        </div>}
        <div className="ai-messages" ref={scrollRef} aria-live="polite" aria-busy={state.busy}>
            {!state.messages.length && <div className="ai-empty"><p>可以一起整理筆記、釐清想法，或檢查研究中的投資假設。</p><p>內容的時間會逐段判斷；未知日期會保留為未知。</p></div>}
            {state.summary && <details className="ai-evidence"><summary>目前討論重點</summary><textarea aria-label="目前討論重點" value={state.summary} onChange={e => aiSession.setSummary(e.target.value)} rows={5} maxLength={10000} /></details>}
            {state.memory && <details className="ai-evidence"><summary>自動整理的討論重點</summary><p>保留近期原文並以重點接續討論。較早細節可能省略，需要時可指出原訊息。</p><p>{state.memory.text}</p></details>}
            {state.contextNotice && <p className="ai-notice" role="status">{state.contextNotice}</p>}
            {state.messages.map((m,index) => <Message key={m.id} message={m} busy={state.busy || !statusReady || !!m.reply?.research && state.messages.slice(index+1).some(next=>next.reply?.research?.token===m.reply!.research!.token)} onResearch={token=>void aiSession.send(location.pathname,false,token)} onSave={message => { setSettings(false); setNote({ id: crypto.randomUUID(), title: message.content.split('\n')[0].slice(0, 80) || 'AI 討論結論', content: message.content + '\n\n' + (message.reply?.sources || []).map(s => `[${s.ref}] ${s.title}\n${window.location.origin}/kms?note=${encodeURIComponent(s.id)}`).join('\n') }); setNotice('') }} onPreference={text => void savePreference(text)} />)}
        </div>
        {note && !settings && <div className="ai-note-form"><div className="ai-inline-actions"><strong>建立新筆記</strong><button aria-label="取消新筆記" onClick={() => setNote(null)} disabled={saving}><X size={16} /></button></div><input aria-label="新筆記標題" value={note.title} onChange={e => setNote({ ...note, title: e.target.value })} maxLength={120} /><textarea aria-label="新筆記內容" value={note.content} onChange={e => setNote({ ...note, content: e.target.value })} rows={4} maxLength={20000} /><button disabled={saving || !note.title.trim()} onClick={() => void saveNote()}><FilePlus2 size={14} />{saving ? '儲存中' : '確認儲存新筆記'}</button></div>}
        {notice && <p className="ai-notice" role="status">{notice}</p>}
        {(state.error || state.storageError) && <div className="ai-error" role="alert">{state.error || state.storageError}{state.error && state.messages.at(-1)?.role === 'user' && <button disabled={state.busy || !statusReady} onClick={() => void aiSession.send(location.pathname, true)}>手動重試</button>}</div>}
        {!state.status?.config.enabled && state.status && <p className="ai-notice">後端設定尚未啟用，可先確認設定與操作介面。</p>}
        <form className="ai-composer" onSubmit={e => { e.preventDefault(); if (canSend) { setNotice(''); void aiSession.send(location.pathname) } }}>
            <textarea ref={inputRef} aria-label="對 AI 說" placeholder="輸入想討論的內容…" value={state.draft} onChange={e => aiSession.setDraft(e.target.value)} rows={2} maxLength={12000} onKeyDown={e => {
                if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return
                e.preventDefault()
                if (canSend && !e.repeat) e.currentTarget.form?.requestSubmit()
            }} />
            <button className="ai-send" type="submit" disabled={!canSend} aria-label="送出 AI 訊息"><Send size={18} /></button>
        </form>
    </section>
}
