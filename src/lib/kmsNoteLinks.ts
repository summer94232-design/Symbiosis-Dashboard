import { getDocs, query, where, runTransaction } from 'firebase/firestore'
import { kmsDB } from './firebase'
import { captureUserSession } from './userDB'

const ids = (value: unknown): string[] => Array.isArray(value)
    ? [...new Set(value.filter((id): id is string => typeof id === 'string' && !!id && !id.includes('/')))] : []

/** Links are symmetric, undirected relationships between live notes. */
export async function mutateLinkedKmsNote(input: {
    id: string
    mode: 'save' | 'delete' | 'restore'
    summary?: object
    body?: object
    expectedUpdatedAt?: string
    expectedGraphRevision?: number
    isNew?: boolean
}) {
    const session = captureUserSession()
    const ref = session.doc(kmsDB, 'notes', input.id)
    const trashRef = session.doc(kmsDB, 'trash', input.id)
    // Include older asymmetric incoming links too; current symmetric edits also touch
    // the source note, which makes the transaction retry on concurrent link changes.
    const incoming = await getDocs(query(session.col(kmsDB, 'notes'), where('links', 'array-contains', input.id)))
    const trashedIncoming = input.mode === 'delete'
        ? await getDocs(query(session.col(kmsDB, 'trash'), where('links', 'array-contains', input.id))) : null
    session.assertActive()
    return runTransaction(kmsDB, async transaction => {
        session.assertActive()
        const current = await transaction.get(ref)
        const trash = input.mode === 'restore' ? await transaction.get(trashRef) : null
        if (input.mode === 'restore' && trash?.data()?.purgeState === 'deleting') throw new Error('附件清理已開始，無法復原；請重試永久刪除以完成清理。')
        if (input.mode === 'restore' && (current.exists() || !trash?.exists())) throw new Error('筆記已復原或垃圾桶資料已變更，請重新整理。')
        if (input.mode !== 'restore' && !input.isNew && !current.exists()) throw new Error('筆記已被刪除，請重新整理。')
        if (input.mode === 'save' && input.isNew && current.exists()) throw new Error('筆記已存在，請重新整理後編輯。')
        const old = current.exists() ? current.data() : {}
        if (input.mode === 'save' && !input.isNew && ((old.updatedAt || '') !== (input.expectedUpdatedAt || '') || (old.graphRevision || 0) !== (input.expectedGraphRevision || 0))) {
            throw new Error('筆記或連結已由其他操作更新，請重新開啟筆記後再修改。')
        }
        const data = input.mode === 'restore' ? trash!.data()! : input.mode === 'save' ? { ...input.summary } as Record<string, unknown> : old
        const desired = ids(data.links).filter(id => id !== input.id)
        const peers = [...new Set([...ids(old.links), ...desired, ...incoming.docs.map(doc => doc.id), ...(trashedIncoming?.docs.map(doc => doc.id) || [])])].filter(id => id !== input.id)
        if (peers.length > 449) throw new Error('關聯超過單次安全更新上限（449），請先減少連結。')
        const snapshots = await Promise.all(peers.map(id => transaction.get(session.doc(kmsDB, 'notes', id))))
        const live = new Set(snapshots.filter(doc => doc.exists()).map(doc => doc.id))
        if (input.mode === 'save' && desired.some(id => !live.has(id))) throw new Error('連結筆記已不存在，請移除失效連結後重試。')
        const links = desired.filter(id => live.has(id))
        const linkedUpdates: Record<string, string[]> = {}
        const now = new Date().toISOString()
        const graphRevision = (Number(old.graphRevision) || 0) + 1
        session.assertActive()
        snapshots.forEach(snapshot => {
            if (!snapshot.exists()) return
            const existing = ids(snapshot.data().links).filter(id => id !== input.id)
            const next = input.mode !== 'delete' && links.includes(snapshot.id) ? [...existing, input.id] : existing
            transaction.update(snapshot.ref, { links: next, updatedAt: now, graphRevision: (Number(snapshot.data().graphRevision) || 0) + 1 })
            linkedUpdates[snapshot.id] = next
        })
        if (input.mode === 'delete') {
            transaction.set(trashRef, { ...old, links: peers, deletedAt: now })
            transaction.delete(ref)
        } else {
            const restored: Record<string, unknown> = { ...data, links, updatedAt: now, graphRevision }
            delete restored.deletedAt
            transaction.set(ref, restored)
            if (input.mode === 'save') transaction.set(session.doc(kmsDB, 'noteBodies', input.id), input.body || {})
            else transaction.delete(trashRef)
        }
        return { links, linkedUpdates, updatedAt: now, graphRevision }
    })
}
