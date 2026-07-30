import { getDoc, getDocs, orderBy, query } from 'firebase/firestore'
import { kmsDB } from './firebase'
import { cache } from './cache'
import { getUID, userCol, userDocNested } from './userDB'

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

const notesKey = () => `kms:notes:${getUID()}`
const tagOrderKey = () => `kms:tag-order:${getUID()}`
const trashKey = () => `kms:trash:${getUID()}`

export async function fetchKmsNotes<T = KmsNoteData>(): Promise<T[]> {
  const rows = await cache.getOrLoad<Record<string, unknown>[]>(notesKey(), async () => {
    const snap = await getDocs(query(userCol(kmsDB, 'notes'), orderBy('createdAt', 'desc')))
    return snap.docs.map(doc => ({ id: doc.id, ...doc.data() }))
  }, TTL_SECONDS)
  return rows.map(row => ({ ...row })) as T[]
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
