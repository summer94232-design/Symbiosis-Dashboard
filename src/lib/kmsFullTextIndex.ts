import { doc, getDocFromServer } from 'firebase/firestore'
import { kmsDB } from './firebase'
import { cache } from './cache'
import { captureUserSession } from './userDB'
import { normalizeKmsSearch } from './kmsSearch'

interface Entry { note: { id: string; [key: string]: unknown }; texts: string[] }
interface Manifest { schema: number; status: string; totalNotes: number; updatedAt: string; buckets: Record<string, { version: string; pages: string[] }> }
export interface KmsSearchProgress { scanned: number; readAttempts: number; asOf: string }
export async function decodeSearchPages(pages: string[]): Promise<Entry[]> {
  const bytes = Uint8Array.from(atob(pages.join('')), char => char.charCodeAt(0))
  const json = await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).text()
  const entries: Entry[] = JSON.parse(json)
  if (!Array.isArray(entries) || entries.some(entry => !entry?.note?.id || !Array.isArray(entry.texts) || entry.texts.some(text => typeof text !== 'string'))) throw new Error('全文索引格式不正確')
  return entries
}
export async function searchKmsFullText<T>(search: string): Promise<KmsSearchProgress & { rows: T[] }> {
  const session = captureUserSession()
  let reads = 0
  const corpus = await cache.getOrLoad(`kms:fulltext:${session.uid}`, async () => {
    const shards = await cache.getOrLoad(`kms:search-index:${session.uid}`, async () => new Map<string, { version: string; rows: Entry[] }>(), Infinity)
    for (let attempt = 0; attempt < 2; attempt++) {
      session.assertActive(); reads++
      const snap = await getDocFromServer(doc(kmsDB, `kmsSearch/${session.uid}/state/manifest`))
      session.assertActive()
      if (!snap.exists() || snap.data().status !== 'ready') throw new Error('全文索引尚未就緒或需要修復，請稍後重試。')
      const manifest = snap.data() as Manifest
      if (manifest.schema !== 1 || !manifest.buckets || !Number.isSafeInteger(manifest.totalNotes)) throw new Error('全文索引版本不相容')
      const entries: Entry[] = []; let changed = false
      for (const [bucketId, bucket] of Object.entries(manifest.buckets)) {
        session.assertActive()
        const previous = shards.get(bucketId)
        if (previous?.version === bucket.version) { entries.push(...previous.rows); continue }
        const pages: string[] = []
        for (const id of bucket.pages) {
          reads++
          const page = await getDocFromServer(doc(kmsDB, `kmsSearch/${session.uid}/fulltextShards/${id}`))
          session.assertActive()
          if (!page.exists() || page.data().version !== bucket.version) { changed = true; break }
          pages.push(page.data().data)
        }
        if (changed) break
        const rows = pages.length ? await decodeSearchPages(pages) : []
        session.assertActive(); shards.set(bucketId, { version: bucket.version, rows }); entries.push(...rows)
      }
      if (changed) continue
      if (entries.length !== manifest.totalNotes || new Set(entries.map(entry => entry.note.id)).size !== entries.length) throw new Error('全文索引不完整，請重試')
      return { entries, asOf: manifest.updatedAt }
    }
    throw new Error('筆記正在更新，請稍後重新搜尋。')
  }, 60)
  session.assertActive()
  const term = normalizeKmsSearch(search).replace(/\s+/g, '')
  return { rows: corpus.entries.filter(entry => entry.texts.some(text => text.includes(term))).map(entry => entry.note) as T[], scanned: corpus.entries.length, readAttempts: reads, asOf: corpus.asOf }
}
export function invalidateKmsFullText() { cache.invalidatePrefix('kms:fulltext:') }
