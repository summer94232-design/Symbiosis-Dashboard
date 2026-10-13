import { investAuth, kmsAuth } from './auth'
import { captureUserSession } from './userDB'
import { authenticatedFetch } from './authenticatedFetch'
import { aiPageContext } from './aiPageContext'
import { buildAiHistory, validConversationMemory, type AiConversationMemory } from './aiConversation'

export interface AiSource { ref: string; id: string; title: string; savedAt: string | null; updatedAt: string | null; passages: { paragraph: number; quote: string }[] }
export interface AiReply {
    answer: string; sources: AiSource[]; citations: { url: string; title: string; quote?: string }[];
    scope: { scanned: number; matched: number; provided: number; indexAsOf?: string; reason?: string; terms?: string[];
        unreadCandidates?: number; summarizedChunks?:number; totalChunks?:number; readCharacters?:number; totalCharacters?:number;
        includedSummaryChunks?:number; complete?:boolean; reusedChunks?:number };
    webVerified: boolean; currentFactsRequested: boolean; webSearches: number; partial: boolean; billingPending: boolean;
    costTwd: number | null; preference?: { text: string; kind: 'explicit' | 'candidate' } | null; searchSuggestions?: string;
    conversationMemory?: string | null; recovery?:string;
    research?: { token:string; limitTwd:number; complete:boolean; canContinue:boolean; costTwd:number; remainingTwd:number; offer?:boolean; reason?:string; synthesisPending?:boolean } | null;
    noteSummaries?:string[];
    usage?: {input:number; output:number; thoughts:number; cached:number; searches:number};
}
export interface AiStatus {
    config: { enabled: boolean; monthlyTwd: number; dailyTwd?:number; turnTwd?:number; researchTwd?:number; webBudgetSafe?:boolean; models: { id: string; label: string; available: boolean }[]; quotaConfirmed: boolean };
    google: { verified: boolean; account: string; project: string };
    preferences: { items: string[]; revision: number } | null;
    budget: { estimatedTwd: number; reservedTwd: number; remainingTwd: number; monthlyTwd: number; dailyEstimatedTwd?:number; dailyReservedTwd?:number; day: string; daily: Record<string, number>; limits: Record<string, number> } | null;
}
export interface AiMessage { id: string; role: 'user' | 'assistant'; content: string; reply?: AiReply; researchToken?:string }
interface AiState { uid: string; messages: AiMessage[]; draft: string; model: string; keyword: string; web: boolean; busy: boolean; error: string; storageError: string; status: AiStatus | null; statusAttempted: boolean; statusLoading: boolean; statusError: string; summary: string; memory: AiConversationMemory | null; contextNotice: string }
const empty = (uid: string): AiState => ({ uid, messages: [], draft: '', model: 'gemini-3.8-flash', keyword: '', web: true, busy: false, error: '', storageError: '', status: null, statusAttempted: false, statusLoading: false, statusError: '', summary: '', memory: null, contextNotice: '' })
const localKey = (uid: string) => `symbiosis:ai-active:${investAuth.app?.options?.projectId || 'invest'}:${uid}`
const cacheKey = (uid:string) => `symbiosis:ai-reading:${investAuth.app?.options?.projectId || 'invest'}:${uid}`
const draftKey = (uid:string) => `${localKey(uid)}:draft`
function replyForHistory(reply: AiReply): AiReply {
    // Reading receipts belong to one shared cache, not every conversation turn.
    // Status, preferences and budget metadata also need only the latest copy.
    return { answer:reply.answer, sources:reply.sources, citations:reply.citations, scope:reply.scope,
        webVerified:reply.webVerified, currentFactsRequested:reply.currentFactsRequested, webSearches:reply.webSearches,
        partial:reply.partial, billingPending:reply.billingPending, costTwd:reply.costTwd, preference:reply.preference,
        searchSuggestions:reply.searchSuggestions, research:reply.research, usage:reply.usage, recovery:reply.recovery }
}
let volatileReading: {uid:string; tokens:string[]} | null = null
export function mergeReadingCache(previous:string[],incoming:string[],now=Date.now()) {
    const values = new Map<string,string>()
    for (const token of [...previous,...incoming]) try {
        if (typeof token !== 'string' || token.length > 5000 || !/^[\w-]+\.[\w-]+$/.test(token)) continue
        const data = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(token.split('.')[0].replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0))))
        if (data.kind !== 'summary' || data.expiresAt <= now || typeof data.value?.id !== 'string' || typeof data.value?.version !== 'string') continue
        const key = `${data.value.id}:${data.value.version}:${data.value.from}`
        values.delete(key); values.set(key,token)
    } catch { /* Server signatures and live versions are verified before reuse. */ }
    return [...values.values()].slice(-256)
}
function readingCache(uid:string) {
    const memory = volatileReading?.uid === uid ? volatileReading.tokens : []
    try { const value = JSON.parse(localStorage.getItem(cacheKey(uid)) || '[]'); return mergeReadingCache(Array.isArray(value) ? value : [],memory) }
    catch { return mergeReadingCache([],memory) }
}
export function restoreAiState(raw: string | null, uid: string): AiState {
    const next = empty(uid)
    try {
        const stored = JSON.parse(raw || '{}')
        if (stored.uid !== uid || stored.schema !== 1) return next
        if (Array.isArray(stored.messages)) next.messages = stored.messages.filter((m: AiMessage) => m && ['user','assistant'].includes(m.role) && typeof m.content === 'string' && typeof m.id === 'string').slice(-200).map((m: AiMessage) => ({
            id: m.id, role: m.role, content: m.content,
            ...(typeof m.researchToken==='string' && m.researchToken.length<=12000 ? {researchToken:m.researchToken} : {}),
            ...(m.reply && Array.isArray(m.reply.sources) && Array.isArray(m.reply.citations) && m.reply.scope && typeof m.reply.scope.scanned === 'number'
                && m.reply.sources.every(s => typeof s.id === 'string' && typeof s.title === 'string' && Array.isArray(s.passages) && s.passages.every(p => typeof p.quote === 'string'))
                ? { reply: replyForHistory(m.reply) } : {}),
        }))
        for (const key of ['draft','model','keyword','summary'] as const) if (typeof stored[key] === 'string') next[key] = stored[key]
        if (validConversationMemory(stored.memory) && next.messages.some(m => m.id === stored.memory.throughId)) next.memory = stored.memory
        if (typeof stored.contextNotice === 'string') next.contextNotice = stored.contextNotice.slice(0, 160)
        next.web = stored.web !== false
    } catch { next.storageError = '本機對話資料無法讀取，已開始新對話' }
    return next
}
function savedState(uid: string) {
    try {
        const restored = restoreAiState(uid ? localStorage.getItem(localKey(uid)) : null, uid)
        const draft = uid ? localStorage.getItem(draftKey(uid)) : null
        if (draft !== null) restored.draft = draft.slice(0,12000)
        return restored
    }
    catch { return { ...empty(uid), storageError: '瀏覽器不允許本機儲存，重新整理後將無法恢復對話' } }
}
let state = savedState(investAuth.currentUser?.uid || '')
let generation = 0
let controller: AbortController | null = null
let statusSequence = 0
const listeners = new Set<() => void>()
const emit = () => listeners.forEach(listener => listener())
function update(patch: Partial<AiState>, persist = false, draftOnly = false) {
    state = { ...state, ...patch }
    if (persist && state.uid) try {
        if ('draft' in patch) localStorage.setItem(draftKey(state.uid),state.draft)
        if (!draftOnly) localStorage.setItem(localKey(state.uid), JSON.stringify({ schema: 1, uid: state.uid, messages: state.messages, draft: state.draft, model: state.model, keyword: state.keyword, web: state.web, summary: state.summary, memory: state.memory, contextNotice: state.contextNotice }))
    } catch { state.storageError = '本機儲存空間不足，重新整理可能無法恢復對話' }
    emit()
}
function invalidateSession() {
    generation++
    controller?.abort(); controller = null
    const sameAccount = investAuth.currentUser && kmsAuth.currentUser && investAuth.currentUser.email?.toLowerCase() === kmsAuth.currentUser.email?.toLowerCase()
    const uid = sameAccount ? investAuth.currentUser?.uid || '' : ''
    if (volatileReading?.uid !== uid) volatileReading = null
    state = savedState(uid)
    statusSequence++
    emit()
}
let previousInvest = investAuth.currentUser, previousKms = kmsAuth.currentUser
const authChanged = () => {
    if (previousInvest !== investAuth.currentUser || previousKms !== kmsAuth.currentUser) {
        previousInvest = investAuth.currentUser; previousKms = kmsAuth.currentUser; invalidateSession()
    }
}
investAuth.onAuthStateChanged(authChanged)
kmsAuth.onAuthStateChanged(authChanged)
async function request(payload: object, signal?: AbortSignal) {
    const session = captureUserSession()
    const response = await authenticatedFetch('/.netlify/functions/ai-assistant', session, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal,
    })
    session.assertActive()
    return await response.json()
}
export const aiSession = {
    subscribe(listener: () => void) { listeners.add(listener); return () => listeners.delete(listener) },
    getSnapshot: () => state,
    setDraft: (draft: string) => update({ draft }, true, true),
    setModel: (model: string) => update({ model }, true),
    setKeyword: (keyword: string) => update({ keyword }, true),
    setWeb: (web: boolean) => update({ web }, true),
    setSummary: (summary: string) => update({ summary }, true),
    applyBudget(budget: AiStatus['budget'], uid: string) {
        if (state.uid === uid && state.status) update({ status: { ...state.status, budget } })
    },
    clear() {
        generation++; controller?.abort(); controller = null
        try { localStorage.removeItem(localKey(state.uid)); localStorage.removeItem(draftKey(state.uid)) } catch { /* Already reflected in storageError on writes. */ }
        update({ messages: [], draft: '', summary: '', memory: null, contextNotice: '', error: '', busy: false }, true)
    },
    async loadStatus(force = false) {
        authChanged()
        if (!state.uid || state.statusLoading || (state.statusAttempted && !force)) return
        const uid = state.uid
        const sequence = ++statusSequence
        update({ statusAttempted: true, statusLoading: true, statusError: '' })
        try {
            const status = await request({ action: 'status', id: crypto.randomUUID() }) as AiStatus
            // New conversations do not invalidate account settings. Account changes do.
            if (state.uid === uid && sequence === statusSequence) update({ status, statusLoading: false, statusError: '' })
        } catch (error) { if (state.uid === uid && sequence === statusSequence) update({ statusLoading: false, statusError: error instanceof Error ? error.message : '設定載入失敗，可手動重新載入' }) }
    },
    async savePreferences(items: string[]) {
        authChanged()
        const activeGeneration = generation
        const preferences = state.status?.preferences
        if (state.statusLoading) throw new Error('設定仍在載入，請稍後再儲存偏好')
        if (!preferences) throw new Error('請先載入雲端偏好')
        const sequence = ++statusSequence
        const status = await request({ action: 'preferences', id: crypto.randomUUID(), revision: preferences.revision, items }) as AiStatus
        if (generation === activeGeneration && sequence === statusSequence) update({ status })
    },
    async send(path: string, retry = false, readingToken = '') {
        authChanged()
        if (state.busy || !state.uid) return
        const retryMessage = retry && state.messages.at(-1)?.role === 'user' ? state.messages.at(-1) : null
        if (retry && !retryMessage) return
        const researchToken = retryMessage?.researchToken || readingToken
        const question = retryMessage?.content || (researchToken ? '接續完整整理筆記，保留已讀範圍、限制與待查證事項。' : state.draft.trim())
        if (!question) return
        if (question.length > 12000) { update({ error: '訊息過長，請分段討論' }); return }
        const activeGeneration = generation, uid = state.uid
        controller = new AbortController()
        const messages = retryMessage ? state.messages : [...state.messages, { id: crypto.randomUUID(), role: 'user' as const, content: question,...(researchToken ? {researchToken} : {}) }]
        // Retry the existing bubble without consuming a draft written while waiting.
        update({ messages, ...(!retryMessage && !researchToken ? { draft: '' } : {}), busy: true, error: '' }, true)
        try {
            const history = buildAiHistory(messages, state.summary, state.memory)
            update({ contextNotice: history.notice }, true)
            const result = await request({ action: 'chat', id: crypto.randomUUID(), model: state.model,
                messages: researchToken ? [{role:'user',content:question}] : history.messages, updateMemory: !researchToken && history.updateMemory,
                keyword: state.keyword, web: state.web, noteSummaries:readingCache(uid),...(researchToken ? {researchToken} : {}), ...aiPageContext(question, path) }, controller.signal) as AiReply & AiStatus
            captureUserSession().assertActive()
            if (generation !== activeGeneration || state.uid !== uid) return
            if (result.noteSummaries?.length) {
                volatileReading = {uid,tokens:mergeReadingCache(readingCache(uid),result.noteSummaries)}
                try { localStorage.setItem(cacheKey(uid),JSON.stringify(volatileReading.tokens)) }
                catch { update({storageError:'本機摘要快取無法儲存；目前仍可重用，重新整理後可能需要重新閱讀筆記'}) }
            }
            const preferences = (state.status?.preferences?.revision || 0) > (result.preferences?.revision || 0) ? state.status!.preferences : result.preferences
            const answerId = crypto.randomUUID()
            const candidate = { text: result.conversationMemory, throughId: answerId }
            const memory = !researchToken && history.updateMemory && !result.partial && validConversationMemory(candidate) ? candidate : state.memory
            update({ messages: [...messages, { id: answerId, role: 'assistant', content: result.answer, reply: replyForHistory(result) }], memory,
                status: { config: result.config, google: result.google, preferences, budget: result.budget } }, true)
        } catch (error) {
            if (generation === activeGeneration && state.uid === uid) update({ error: error instanceof Error ? error.message : 'AI 請求失敗，請手動重試' })
        } finally { if (generation === activeGeneration && state.uid === uid) { controller = null; update({ busy: false }) } }
    },
    keepSummary(summary: string) {
        generation++; controller?.abort(); controller = null
        const sources = state.messages.filter(m => m.reply?.sources.length).flatMap(m => m.reply?.sources || [])
        const evidence = [...new Map(sources.map(s => [s.id,s])).values()].slice(-6).map(s => `${s.title}（保存 ${s.savedAt || '未知'}，非來源日期）：${s.passages.map(p => `第${p.paragraph}段：${p.quote}`).join('\n')}`).join('\n')
        update({ summary: `${summary}\n\n先前提供的筆記摘錄（需重新查證現況）：\n${evidence}`.slice(0, 10000), memory: null, contextNotice: '', messages: [], draft: '', busy: false, error: '' }, true)
    },
}
