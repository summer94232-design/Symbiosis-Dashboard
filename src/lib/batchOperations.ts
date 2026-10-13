import { getDocs, runTransaction } from 'firebase/firestore'
import { investDB, kmsDB } from './firebase'
import { captureUserSession } from './userDB'
import { buildKmsSearchTerms, buildKmsTagPaths } from './kmsSearch'
import type { KmsTagOrder } from './kmsData'

const unique = (values: string[]) => [...new Set(values)]
const orderValue = (value: Partial<KmsTagOrder>) => JSON.stringify({
    parentOrder: value.parentOrder || [],
    childOrder: Object.fromEntries(Object.entries(value.childOrder || {}).sort(([a], [b]) => a.localeCompare(b))),
})

export async function saveKmsTagOrder(next: KmsTagOrder, expected: KmsTagOrder, session = captureUserSession()) {
    const ref = session.doc(kmsDB, 'settings', 'tagOrder')
    await runTransaction(kmsDB, async transaction => {
        const current = await transaction.get(ref)
        session.assertActive()
        if (orderValue(current.data() || {}) !== orderValue(expected)) throw new Error('標籤排序已被其他操作更新，請重新整理後再試。')
        transaction.set(ref, { ...next, updatedAt: new Date().toISOString() }, { merge: true })
    })
    session.assertActive()
}

/** One transaction: no half-renamed notes or ordering. Large requests stop before writing. */
export async function renameKmsTag(oldTag: string, newTag: string, expectedOrder: KmsTagOrder, session = captureUserSession()) {
    if (!oldTag || !newTag || oldTag === newTag) return { count: 0, order: expectedOrder }
    if (newTag.startsWith(oldTag + '/')) throw new Error('新標籤不能放在原標籤的子層，否則重試會重複增加層級。')
    const matches = (tag: string) => tag === oldTag || tag.startsWith(oldTag + '/')
    const rename = (tag: string) => matches(tag) ? newTag + tag.slice(oldTag.length) : tag
    const snapshot = await getDocs(session.col(kmsDB, 'notes'))
    session.assertActive()
    const ids = snapshot.docs.filter(doc => (doc.data().hashtags || []).some(matches)).map(doc => doc.id)
    if (ids.length > 449) throw new Error('此次涉及超過 449 則筆記，尚未寫入；請先分別處理子標籤。')
    const orderRef = session.doc(kmsDB, 'settings', 'tagOrder')
    return runTransaction(kmsDB, async transaction => {
        const refs = ids.map(id => session.doc(kmsDB, 'notes', id))
        const [orderSnap, ...notes] = await Promise.all([transaction.get(orderRef), ...refs.map(ref => transaction.get(ref))])
        session.assertActive()
        const currentOrder = orderSnap.data() || {}
        if (orderValue(currentOrder) !== orderValue(expectedOrder)) throw new Error('標籤排序已變更，尚未改名；請重新整理後再試。')
        const children: Record<string, string[]> = {}
        Object.entries(expectedOrder.childOrder).forEach(([parent, tags]) => {
            const key = rename(parent)
            children[key] = unique([...(children[key] || []), ...tags.map(rename)])
        })
        const order = { parentOrder: unique(expectedOrder.parentOrder.map(rename)), childOrder: children }
        let count = 0
        notes.forEach((note, index) => {
            if (!note.exists()) return
            const data = note.data()!
            const tags: string[] = Array.isArray(data.hashtags) ? data.hashtags : []
            if (!tags.some(matches)) return
            const hashtags = unique(tags.map(rename))
            transaction.update(refs[index], {
                hashtags, searchTerms: buildKmsSearchTerms(data.title || '', hashtags),
                tagPaths: buildKmsTagPaths(hashtags), isUntagged: hashtags.length === 0,
                updatedAt: new Date().toISOString(),
            })
            count++
        })
        transaction.set(orderRef, { ...order, updatedAt: new Date().toISOString() }, { merge: true })
        return { count, order }
    })
}

interface IndustryEntry { code: string; name: string; market?: string; themes: string[]; note?: string }
const entryValue = (entry: Partial<IndustryEntry>) => JSON.stringify([entry.name || '', entry.market || 'TW', entry.themes || [], entry.note || ''])

export async function saveIndustryEntry(entry: IndustryEntry, relations: { up: string[]; down: string[] }, expected: IndustryEntry | null, session = captureUserSession()) {
    const rels = [...relations.up.map(from => ({ from, to: entry.code })), ...relations.down.map(to => ({ from: entry.code, to }))]
    const uniqueRels = [...new Map(rels.filter(rel => rel.from !== rel.to).map(rel => [`${rel.from}__${rel.to}`.replace(/\//g, '_'), rel])).entries()]
    if (uniqueRels.length > 449) throw new Error('關係超過單次安全儲存上限，尚未寫入；請減少本次關係數。')
    const ref = session.doc(investDB, 'industryMap', entry.code)
    await runTransaction(investDB, async transaction => {
        const relRefs = uniqueRels.map(([id]) => session.doc(investDB, 'industryRelations', id))
        const [current, ...existingRels] = await Promise.all([transaction.get(ref), ...relRefs.map(rel => transaction.get(rel))])
        session.assertActive()
        const alreadySaved = current.exists() && entryValue(current.data() || {}) === entryValue(entry)
        if (!alreadySaved && (expected ? !current.exists() || entryValue(current.data() || {}) !== entryValue(expected) : current.exists())) {
            throw new Error('這筆股票資料已存在或已被更新，請重新整理後開啟編輯。')
        }
        existingRels.forEach((existing, index) => {
            const rel = uniqueRels[index][1]
            if (existing.exists() && (existing.data()!.from !== rel.from || existing.data()!.to !== rel.to)) throw new Error('關係識別碼衝突，尚未寫入。')
        })
        transaction.set(ref, { name: entry.name, market: entry.market || 'TW', themes: unique(entry.themes), note: entry.note || '' })
        uniqueRels.forEach(([, rel], index) => transaction.set(relRefs[index], rel, { merge: true }))
    })
    session.assertActive()
}
