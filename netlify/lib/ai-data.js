import { cert, getApps, initializeApp } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'
import { gunzipSync } from 'node:zlib'
import { MAX_INDEX_PAGES, MAX_NOTES, shouldRetrieve } from './ai-policy.js'
import { createSearchPlan, matchSearchPlan, normalizeSearchText } from './ai-search.js'
import { cachedApi } from './api-access.js'
import { uidHash } from './ai-budget.js'
import { intentSearchPlan } from './ai-intent.js'
import { diverseNotes, noteFeatures, noteVersion, splitNote, RESEARCH_NOTES } from './ai-reading.js'

export function getAiKmsDb() {
    const projectId = process.env.AI_KMS_PROJECT_ID
    if (!projectId || !process.env.AI_KMS_SERVICE_ACCOUNT) throw new Error('AI 知識庫後端讀取設定尚未完成')
    let app = getApps().find(app => app.name === 'ai-kms')
    if (!app) {
        const account = JSON.parse(process.env.AI_KMS_SERVICE_ACCOUNT)
        if (account.project_id !== projectId) throw new Error('AI 知識庫專案設定不一致')
        app = initializeApp({ credential: cert(account), projectId }, 'ai-kms')
    }
    return getFirestore(app)
}
export function plainBody(body) {
    const paragraphs = []
    const visit = node => {
        if (!node || typeof node !== 'object') return ''
        if (typeof node.text === 'string') return node.text
        const text = Array.isArray(node.content) ? node.content.map(visit).join('') : ''
        if (['paragraph', 'heading', 'codeBlock'].includes(node.type)) { if (text.trim()) paragraphs.push(text); return '\n' }
        return text
    }
    if (body?.contentDoc) visit(body.contentDoc)
    if (paragraphs.length) return paragraphs.join('\n\n')
    return String(body?.content || '').replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, '')
        .replace(/<\/(?:p|div|li|h[1-6])\s*>|<br\s*\/?>/gi, '\n').replace(/<[^>]*>/g, '')
        .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
}
export function selectPassages(text, terms, maxChars = 2600, contextTerms = []) {
    const rows = text.split(/\n+/).map(s => s.trim()).filter(Boolean)
    const scored = rows.map((value, index) => { const normalized = normalizeSearchText(value); return { value, index,
        score: terms.reduce((s, term) => s + (normalized.includes(term) ? 1 : 0), 0),
        context: contextTerms.reduce((s, term) => s + (normalized.includes(term) ? 1 : 0), 0) } })
    const core = scored.filter(r => r.score > 0).sort((a,b) => b.score - a.score)
    const centers = core.slice(0, contextTerms.length ? 2 : 3)
    if (contextTerms.length) {
        const related = scored.filter(r => r.context > 0 && !centers.includes(r)).sort((a,b) => b.context-a.context)[0] || core.find(r => !centers.includes(r))
        if (related) centers.push(related)
    }
    // Matching paragraphs receive excerpt space before neighbouring paragraphs.
    const indices = new Set(centers.length ? [...centers.map(r => r.index), ...centers.flatMap(r => [r.index - 1, r.index + 1])] : rows.slice(0, 3).map((_, i) => i))
    let size = 0
    return [...indices].filter(i => i >= 0 && i < rows.length).map(i => {
        const limit = Math.max(0, Math.min(1600, maxChars - size))
        const firstMatch = terms.map(term => rows[i].toLocaleLowerCase('zh-TW').indexOf(term)).filter(n => n >= 0).sort((a,b) => a-b)[0]
        const start = rows[i].length > limit && firstMatch >= limit ? Math.max(0, firstMatch - Math.floor(limit / 3)) : 0
        const quote = (start ? '…' : '') + rows[i].slice(start, start + Math.max(0, limit - (start ? 1 : 0)))
        size += quote.length
        return { paragraph: i + 1, quote }
    }).filter(p => p.quote && p.quote !== '…').sort((a,b) => a.paragraph-b.paragraph)
}
async function loadIndex(db, uid) {
    return cachedApi(`ai-index:${process.env.AI_KMS_PROJECT_ID}:${uidHash(uid)}`, 120000, async () => {
        const manifest = await db.doc(`kmsSearch/${uid}/state/manifest`).get()
        const data = manifest.data()
        if (!manifest.exists || data?.status !== 'ready' || data?.schema !== 1) throw new Error('全文索引尚未就緒，請先在知識庫確認搜尋可用')
        const pages = Object.values(data.buckets || {}).flatMap(bucket => bucket.pages || [])
        if (pages.length > MAX_INDEX_PAGES) throw new Error('全文索引超過 AI 的單次讀取目標，請縮小資料範圍後再設定')
        const entries = []
        let decodedBytes = 0
        for (const bucket of Object.values(data.buckets || {})) {
            const chunks = []
            for (const id of bucket.pages || []) {
                const snap = await db.doc(`kmsSearch/${uid}/fulltextShards/${id}`).get()
                if (!snap.exists || snap.data().version !== bucket.version) throw new Error('全文索引正在更新，請手動重試')
                chunks.push(snap.data().data)
            }
            if (chunks.length) {
                const decoded = gunzipSync(Buffer.from(chunks.join(''), 'base64'), { maxOutputLength: 8 * 1024 * 1024 })
                decodedBytes += decoded.length
                if (decodedBytes > 16 * 1024 * 1024) throw new Error('全文索引超過單次安全處理大小，請縮小資料範圍')
                entries.push(...JSON.parse(decoded.toString('utf8')))
            }
        }
        if (entries.length !== data.totalNotes || new Set(entries.map(e => e.note.id)).size !== entries.length) throw new Error('全文索引不完整，請先修復知識庫索引')
        return { entries, asOf: data.updatedAt }
    })
}
export async function retrieveNotes(db, uid, question, keyword, noteId, intent, completeReading = false) {
    const plan = intent ? intentSearchPlan(intent) : createSearchPlan(question, keyword), { terms } = plan
    if (!noteId && (!terms.length || !intent && !shouldRetrieve(question) && !keyword)) return { sources: [], scope: { scanned: 0, matched: 0, provided: 0, reason: '本輪沒有搜尋筆記' } }
    const manual = keyword?.trim() ? createSearchPlan(question, keyword) : null
    const index = await loadIndex(db, uid)
    const ranked = diverseNotes(index.entries.map(entry => ({ note: entry.note, features: noteFeatures(entry.texts),
        score: (!manual || matchSearchPlan(manual, entry.texts, entry.note.title)) && matchSearchPlan(plan, entry.texts, entry.note.title) }))
        .filter(row => row.score > 0 && (!row.note.type || ['note','url'].includes(row.note.type))).sort((a,b) => b.score - a.score))
    const candidates = [...new Set([...(noteId ? [noteId] : []), ...ranked.map(row => row.note.id)])]
    const ids = candidates.slice(0, completeReading ? RESEARCH_NOTES : MAX_NOTES)
    const sources = [], documents = []
    for (const id of ids) {
        if (typeof id !== 'string' || !/^[^/]{1,160}$/.test(id)) continue
        // Read the live summary as well: an old cached index cannot resurrect a deleted note.
        const note = await db.doc(`users/${uid}/notes/${id}`).get()
        if (!note.exists) continue
        const summary = note.data()
        if (summary.type && !['note','url'].includes(summary.type)) continue
        const body = await db.doc(`users/${uid}/noteBodies/${id}`).get()
        const text = plainBody(body.exists ? body.data() : summary)
        // Cached hits must still satisfy the conditions in the live content.
        const liveTexts = [summary.title, ...(Array.isArray(summary.hashtags) ? summary.hashtags : []), summary.url, text]
        if (id !== noteId && (!matchSearchPlan(plan, liveTexts, summary.title) || manual && !matchSearchPlan(manual, liveTexts, summary.title))) continue
        if (!text.trim()) continue
        const title = String(summary.title || '未命名筆記').slice(0,300)
        documents.push({ id, title, text, version: noteVersion(title,text), chunks: splitNote(text),
            savedAt: summary.createdAt || null, updatedAt: summary.updatedAt || null })
        const passages = selectPassages(text, plan.passageTerms, 2600, intent ? intent.optionalTerms : [])
        if (!passages.length) continue
        sources.push({ ref: `N${sources.length + 1}`, id, title: String(summary.title || '未命名筆記').slice(0,300), url: typeof summary.url === 'string' ? summary.url : '',
            tags: Array.isArray(summary.hashtags) ? summary.hashtags.filter(tag => typeof tag === 'string').slice(0,20) : [],
            savedAt: summary.createdAt || null, updatedAt: summary.updatedAt || null,
            sourceDate: null, expectedDate: null, verifiedAt: null, passages, excerptOnly: true })
    }
    return { sources, documents, scope: { scanned: index.entries.length, matched: ranked.length, provided: sources.length,
        unreadCandidates: Math.max(0,candidates.length - ids.length), selectedNotes: documents.length,
        reading: documents.map(d => ({ id:d.id,title:d.title,characters:d.text.length,excerptCharacters:sources.find(s=>s.id===d.id)?.passages.reduce((n,p)=>n+p.quote.length,0) || 0 })),
        indexAsOf: index.asOf, terms, coreTerms: plan.core, excludedTerms: plan.excluded, conditions: plan.groups, recipe: plan.recipe,
        excerptOnly: true, method: intent ? '模型理解目前對話後產生檢索概念，再匹配原筆記與摘錄；未使用向量索引' : '核心條件文字匹配與常見食材名稱對應；非語意搜尋，仍可能漏掉其他用詞' } }
}
export async function readPreferences(db, uid) {
    const snap = await db.doc(`aiPreferences/${uidHash(uid)}`).get()
    const data = snap.data() || {}
    return { revision: Number(data.revision) || 0, items: Array.isArray(data.items) ? data.items.filter(p => typeof p === 'string').slice(0, 30) : [] }
}
export async function writePreferences(db, uid, items, revision) {
    const ref = db.doc(`aiPreferences/${uidHash(uid)}`)
    return db.runTransaction(async tx => {
        const snap = await tx.get(ref), old = snap.data() || {}
        if ((Number(old.revision) || 0) !== revision) throw new Error('偏好已由其他裝置更新，請重新載入後再儲存')
        const next = { items, revision: revision + 1 }
        if (JSON.stringify(old.items || []) === JSON.stringify(items)) return { items, revision }
        tx.set(ref, { ...next, updatedAt: new Date().toISOString() })
        return next
    }, { maxAttempts: 1 })
}
export async function retrieveInvest(db, uid, question, intent) {
    const collections = intent ? intent.investment === 'trades' ? ['trades'] : intent.investment === 'research' ? ['watchlist','sentiments'] : []
        : /持倉|持股|交易|買賣紀錄|帳務/.test(question) ? ['trades']
        : /我的.{0,10}(?:選股|追蹤|觀點)|追蹤清單/.test(question) ? ['watchlist','sentiments'] : []
    const fields = ['code','name','market','date','type','shares','price','note','reason','thesis','targetPrice','stopLoss','addedAt','updatedAt']
    const result = []
    for (const collection of collections) {
        const base = db.collection(`users/${uid}/${collection}`)
        const snap = await (collection === 'trades' ? base.orderBy('date', 'desc') : base).limit(20).get()
        const rows = snap.docs.map(doc => {
            const data = doc.data(), row = {}, truncatedFields = []
            let textLeft = 240
            for (const key of fields) {
                const value = data[key]
                if (typeof value === 'number' && Number.isFinite(value) || typeof value === 'boolean') row[key] = value
                else if (typeof value === 'string') {
                    const prose = ['note','reason','thesis'].includes(key), limit = prose ? Math.min(120,textLeft) : 96
                    row[key] = value.length > limit ? value.slice(0,limit) + '…' : value
                    if (prose) textLeft -= Math.min(value.length,limit)
                    if (value.length > limit) truncatedFields.push(key)
                }
                else if (value !== undefined && value !== null) truncatedFields.push(key)
            }
            if (truncatedFields.length) row.truncatedFields = truncatedFields
            return row
        })
        result.push({ collection, limit: 20, complete: false, excerptOnly:rows.some(row=>row.truncatedFields), rows })
    }
    return result
}
