import { createHash, randomUUID } from 'node:crypto'
import { gzipSync, gunzipSync } from 'node:zlib'

export const bucketFor = id => createHash('sha256').update(id).digest('hex')[0]
const normalize = value => String(value || '').normalize('NFKC').trim().toLocaleLowerCase('zh-TW').replace(/\s+/g, '')
export function entryFor(id, note, body) {
  if (!note) return null
  const parts = [body?.content ?? note.content ?? '']
  const visit = node => {
    if (!node || typeof node !== 'object') return
    if (typeof node.text === 'string') parts.push(node.text)
    if (Array.isArray(node.content)) node.content.forEach(visit)
  }
  visit(body ? body.contentDoc : note.contentDoc)
  const summary = { id, content: '' }
  for (const key of ['title','type','url','imageUrl','coverAssetId','coverThumbnailUrl','articleThumbnailUrl','fileUrl','fileName','fileStoragePath','hashtags','links','graphRevision','createdAt','updatedAt']) if (note[key] !== undefined) summary[key] = note[key]
  return { note: summary, texts: [note.title, ...(note.hashtags || []), note.url, parts.join(' ')].map(normalize) }
}
export function packEntries(entries, size = 640000) {
  const data = gzipSync(JSON.stringify(entries)).toString('base64')
  return Array.from({ length: Math.ceil(data.length / size) }, (_, i) => data.slice(i * size, (i + 1) * size))
}
export const unpackEntries = pages => JSON.parse(gunzipSync(Buffer.from(pages.join(''), 'base64')).toString('utf8'))

export async function updateSearchNote(db, uid, idOrIds) {
  const ids = Array.isArray(idOrIds) ? [...new Set(idOrIds)] : [idOrIds]
  if (!ids.length) return
  const bucket = bucketFor(ids[0])
  if (ids.some(id => bucketFor(id) !== bucket)) throw new Error('Batch must belong to one bucket')
  const root = `kmsSearch/${uid}`, manifestRef = db.doc(`${root}/state/manifest`)
  await db.runTransaction(async tx => {
    const snapshot = await tx.get(manifestRef)
    if (!snapshot.exists) return
    const manifest = snapshot.data()
    if (manifest.schema !== 1) throw new Error('Unsupported search index schema')
    const old = manifest.buckets[bucket], pages = []
    for (const page of old?.pages || []) {
      const snap = await tx.get(db.doc(`${root}/fulltextShards/${page}`))
      if (!snap.exists) throw new Error('Missing search shard')
      pages.push(snap.data().data)
    }
    const entries = pages.length ? unpackEntries(pages) : []
    let delta = 0, changed = false
    for (const id of ids) {
      const note = await tx.get(db.doc(`users/${uid}/notes/${id}`))
      const body = await tx.get(db.doc(`users/${uid}/noteBodies/${id}`))
      const index = entries.findIndex(entry => entry.note.id === id)
      const entry = entryFor(id, note.exists ? note.data() : null, body.exists ? body.data() : null)
      if (JSON.stringify(index < 0 ? null : entries[index]) === JSON.stringify(entry)) continue
      changed = true; delta += Number(Boolean(entry)) - Number(index >= 0)
      if (index >= 0) entries.splice(index, 1)
      if (entry) entries.push(entry)
    }
    if (!changed) return
    entries.sort((a, b) => a.note.id.localeCompare(b.note.id))
    const packed = entries.length ? packEntries(entries) : []
    if (packed.length + (old?.pages.length || 0) > 12) throw new Error('Search shard exceeds transaction budget')
    const version = randomUUID(), pageIds = packed.map((_, i) => `${bucket}-${version}-${i}`)
    packed.forEach((data, i) => tx.set(db.doc(`${root}/fulltextShards/${pageIds[i]}`), { version, data }))
    for (const page of old?.pages || []) tx.delete(db.doc(`${root}/fulltextShards/${page}`))
    tx.update(manifestRef, { [`buckets.${bucket}`]: { version, pages: pageIds }, totalNotes: manifest.totalNotes + delta, revision: version, updatedAt: new Date().toISOString() })
  })
}

export const RETRY_WINDOW_MS = 15 * 60 * 1000
export async function handleSearchEvent(db, event, now = Date.now()) {
  const timestamp = Date.parse(event.time)
  if (!Number.isFinite(timestamp) || now - timestamp > RETRY_WINDOW_MS) {
    // Acknowledge expired events, but visibly invalidate the corpus rather than silently lose updates.
    const ref = db.doc(`kmsSearch/${event.params.userId}/state/manifest`)
    try {
      await db.runTransaction(async tx => {
        const snap = await tx.get(ref)
        if (snap.exists) tx.update(ref, { status: 'degraded', failureAt: new Date(now).toISOString() })
      })
    } catch { console.error('SEARCH_INDEX_EXPIRY_MARK_FAILED', { eventId: event.id }) }
    console.error('SEARCH_INDEX_REPAIR_REQUIRED', { eventId: event.id })
    return
  }
  await updateSearchNote(db, event.params.userId, event.params.noteId)
}
