import { getDoc, getDocs, limit, orderBy, query, startAfter, where, type DocumentData, type QueryDocumentSnapshot } from 'firebase/firestore'
import { kmsDB } from './firebase'
import { cache } from './cache'
import { getUID, userCol, userDoc, userDocNested } from './userDB'
import { normalizeKmsSearch } from './kmsSearch'

const TTL_SECONDS = 90
const TAG_ORDER_DOC = 'tagOrder'
export const KMS_UNTAGGED_KEY = '__untagged__'

export interface KmsNoteData {
  id: string
  title?: string
  content?: string
  type?: string
  hashtags?: string[]
  links?: string[]
  createdAt?: string
  updatedAt?: string
  [key: string]: unknown
}

export interface KmsTagOrder {
  parentOrder: string[]
  childOrder: Record<string, string[]>
}

export interface KmsNoteBody {
  content: string
  contentDoc?: unknown
  assets?: unknown[]
}

export interface KmsNotePage<T> {
  rows: T[]
  cursor: QueryDocumentSnapshot<DocumentData> | null
  hasMore: boolean
}

export interface KmsTagStats {
  counts: Record<string, number>
  rootCounts: Record<string, number>
  totalNotes: number
  untagged: number
  updatedAt?: string
}

export function buildKmsTagStatsFromSummaries(
  notes: Array<{ hashtags?: string[] }>,
): KmsTagStats {
  const counts: Record<string, number> = {}
  const rootCounts: Record<string, number> = {}
  let untagged = 0

  notes.forEach(note => {
    const tags = [...new Set((note.hashtags || []).filter(Boolean))]
    if (tags.length === 0) {
      untagged += 1
      return
    }
    tags.forEach(tag => { counts[tag] = (counts[tag] || 0) + 1 })
    new Set(tags.map(tag => tag.split('/')[0])).forEach(root => {
      rootCounts[root] = (rootCounts[root] || 0) + 1
    })
  })

  return { counts, rootCounts, totalNotes: notes.length, untagged }
}

export function hasUsableKmsTagStats(stats: KmsTagStats | null): stats is KmsTagStats {
  return Boolean(stats && (stats.totalNotes > 0 || Object.keys(stats.counts).length > 0 || stats.untagged > 0))
}

export function parseKmsTagStats(data: Record<string, unknown>): KmsTagStats {
  return {
    counts: data.counts && typeof data.counts === 'object' ? data.counts as Record<string, number> : {},
    rootCounts: data.rootCounts && typeof data.rootCounts === 'object' ? data.rootCounts as Record<string, number> : {},
    totalNotes: Number(data.totalNotes) || 0,
    untagged: Number(data.untagged) || 0,
    updatedAt: typeof data.updatedAt === 'string' ? data.updatedAt : undefined,
  }
}

const notesKey = () => `kms:notes:${getUID()}`
const tagOrderKey = () => `kms:tag-order:${getUID()}`
const trashKey = () => `kms:trash:${getUID()}`

export async function fetchKmsNotes<T = KmsNoteData>(): Promise<T[]> {
  const rows = await cache.getOrLoad<Record<string, unknown>[]>(notesKey(), async () => {
    const [notesSnapshot, bodiesSnapshot] = await Promise.all([
      getDocs(query(userCol(kmsDB, 'notes'), orderBy('createdAt', 'desc'))),
      getDocs(userCol(kmsDB, 'noteBodies')),
    ])
    const bodies = new Map(bodiesSnapshot.docs.map(body => [body.id, body.data()]))
    return notesSnapshot.docs.map(note => ({ id: note.id, ...note.data(), ...(bodies.get(note.id) || {}) }))
  }, TTL_SECONDS)
  return rows.map(row => ({ ...row })) as T[]
}

export async function fetchKmsNoteSummaries<T = KmsNoteData>(): Promise<T[]> {
  const snapshot = await getDocs(query(userCol(kmsDB, 'notes'), orderBy('createdAt', 'desc')))
  return snapshot.docs.map(note => ({ id: note.id, ...note.data() })) as T[]
}

export async function fetchKmsTagStats(): Promise<KmsTagStats | null> {
  const snapshot = await getDoc(userDoc(kmsDB, 'metadata', 'tagStats'))
  if (!snapshot.exists()) return null
  return parseKmsTagStats(snapshot.data())
}

export async function searchKmsNoteSummaries<T = KmsNoteData>(
  search: string,
  selectedTag: string,
  pageSize = 0,
): Promise<T[]> {
  const notes = userCol(kmsDB, 'notes')
  const normalized = normalizeKmsSearch(search).replace(/\s+/g, '').slice(0, 12)
  const filter = normalized
    ? where('searchTerms', 'array-contains', normalized)
    : selectedTag === KMS_UNTAGGED_KEY
      ? where('isUntagged', '==', true)
      : where('tagPaths', 'array-contains', selectedTag)
  const resultQuery = pageSize > 0 ? query(notes, filter, limit(pageSize)) : query(notes, filter)
  const snapshot = await getDocs(resultQuery)
  return snapshot.docs.map(note => ({ id: note.id, ...note.data() })) as T[]
}

export async function fetchKmsBodiesInBatches<T = KmsNoteBody>(
  noteIds: string[],
  batchSize = 20,
  onProgress: (completed: number, total: number) => void = () => undefined,
): Promise<Record<string, T>> {
  const result: Record<string, T> = {}
  for (let start = 0; start < noteIds.length; start += batchSize) {
    const ids = noteIds.slice(start, start + batchSize)
    const bodies = await Promise.all(ids.map(id => fetchKmsNoteBody<T>(id)))
    ids.forEach((id, index) => { result[id] = bodies[index] })
    onProgress(Math.min(start + ids.length, noteIds.length), noteIds.length)
  }
  return result
}

export async function fetchKmsNotePage<T = KmsNoteData>(
  pageSize = 40,
  cursor?: QueryDocumentSnapshot<DocumentData> | null,
): Promise<KmsNotePage<T>> {
  const constraints = [orderBy('createdAt', 'desc')]
  const pageQuery = cursor
    ? query(userCol(kmsDB, 'notes'), ...constraints, startAfter(cursor), limit(pageSize + 1))
    : query(userCol(kmsDB, 'notes'), ...constraints, limit(pageSize + 1))
  const snapshot = await getDocs(pageQuery)
  const hasMore = snapshot.docs.length > pageSize
  const pageDocs = snapshot.docs.slice(0, pageSize)
  return {
    rows: pageDocs.map(note => ({ id: note.id, ...note.data() })) as T[],
    cursor: pageDocs.at(-1) || null,
    hasMore,
  }
}

export async function fetchKmsNoteBody<T = KmsNoteBody>(noteId: string): Promise<T> {
  const snapshot = await getDoc(userDoc(kmsDB, 'noteBodies', noteId))
  if (snapshot.exists()) return snapshot.data() as T

  // 遷移前相容：舊資料的正文仍在 notes 文件內。
  const legacy = await getDoc(userDoc(kmsDB, 'notes', noteId))
  const data = legacy.exists() ? legacy.data() : {}
  return {
    content: typeof data.content === 'string' ? data.content : '',
    contentDoc: data.contentDoc,
    assets: Array.isArray(data.assets) ? data.assets : [],
  } as T
}

export async function fetchKmsNoteSummary<T = KmsNoteData>(noteId: string): Promise<T | null> {
  const snapshot = await getDoc(userDoc(kmsDB, 'notes', noteId))
  return snapshot.exists() ? ({ id: snapshot.id, ...snapshot.data() } as T) : null
}

export function fetchKmsTagOrder(): Promise<KmsTagOrder> {
  return cache.getOrLoad<KmsTagOrder>(tagOrderKey(), async () => {
    const snap = await getDoc(userDocNested(kmsDB, 'settings', TAG_ORDER_DOC))
    if (!snap.exists()) return { parentOrder: [], childOrder: {} }
    const data = snap.data()
    return {
      parentOrder: Array.isArray(data.parentOrder) ? data.parentOrder : [],
      childOrder: data.childOrder && typeof data.childOrder === 'object' ? data.childOrder : {},
    }
  }, TTL_SECONDS)
}

export async function fetchKmsTrash<T = Record<string, unknown>>(): Promise<T[]> {
  const rows = await cache.getOrLoad<Record<string, unknown>[]>(trashKey(), async () => {
    const snap = await getDocs(userCol(kmsDB, 'trash'))
    return snap.docs.map(doc => ({ id: doc.id, ...doc.data() }))
  }, TTL_SECONDS)
  return rows.map(row => ({ ...row })) as T[]
}

export function invalidateKmsNotes(): void {
  cache.invalidatePrefix('kms:notes:')
}

export function invalidateKmsTagOrder(): void {
  cache.invalidatePrefix('kms:tag-order:')
}

export function invalidateKmsTrash(): void {
  cache.invalidatePrefix('kms:trash:')
}

export function invalidateAllKmsData(): void {
  cache.invalidatePrefix('kms:')
}
