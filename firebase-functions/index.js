import { entryFor, handleSearchEvent } from './search-index.js'
import { initializeApp } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'
import { getStorage } from 'firebase-admin/storage'
import { getAuth } from 'firebase-admin/auth'
import { onDocumentWritten } from 'firebase-functions/v2/firestore'
import { defineBoolean } from 'firebase-functions/params'
import { onSchedule } from 'firebase-functions/v2/scheduler'

initializeApp()
const db = getFirestore()

const searchOptions = { region: 'asia-east1', retry: true, maxInstances: 2, concurrency: 4, timeoutSeconds: 60, memory: '256MiB' }
export const maintainKmsFullTextNotes = onDocumentWritten({ ...searchOptions, document: 'users/{userId}/notes/{noteId}' }, async event => {
  const before = event.data?.before.exists ? event.data.before.data() : null
  const after = event.data?.after.exists ? event.data.after.data() : null
  if (JSON.stringify(entryFor(event.params.noteId, before, null)) === JSON.stringify(entryFor(event.params.noteId, after, null))) return
  await handleSearchEvent(db, event)
})
export const maintainKmsFullTextBodies = onDocumentWritten({ ...searchOptions, document: 'users/{userId}/noteBodies/{noteId}' }, async event => {
  if (event.data?.before.exists === event.data?.after.exists && JSON.stringify(entryFor('', {}, event.data?.before.data())) === JSON.stringify(entryFor('', {}, event.data?.after.data()))) return
  await handleSearchEvent(db, event)
})

const kmsImageCleanupEnabled = defineBoolean('KMS_IMAGE_CLEANUP_ENABLED', {
  default: false,
  description: 'Allow the scheduled KMS orphan-image cleanup to delete drafts and Storage objects.',
})

function normalize(value) {
  return String(value || '').normalize('NFKC').trim().toLocaleLowerCase('zh-TW').replace(/\s+/g, '')
}

function searchTerms(title, hashtags = []) {
  const terms = new Set()
  for (const source of [title, ...hashtags].map(normalize).filter(Boolean)) {
    for (let start = 0; start < source.length && terms.size < 300; start += 1) {
      for (let length = 1; length <= Math.min(12, source.length - start) && terms.size < 300; length += 1) {
        terms.add(source.slice(start, start + length))
      }
    }
  }
  return [...terms]
}

function tagPaths(hashtags = []) {
  const paths = new Set()
  for (const tag of hashtags) {
    const parts = String(tag).split('/').map(part => part.trim()).filter(Boolean)
    parts.forEach((_, index) => paths.add(parts.slice(0, index + 1).join('/')))
  }
  return [...paths]
}

function sameArray(left = [], right = []) {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

export const maintainKmsNoteMetadata = onDocumentWritten({
  document: 'users/{userId}/notes/{noteId}',
  region: 'asia-east1',
  retry: true,
}, async event => {
  // Recompute from current documents, never from a possibly duplicated/out-of-order event delta.
  // One transaction keeps the aggregate and the event note's derived fields consistent.
  const notesRef = db.collection(`users/${event.params.userId}/notes`)
  const statsRef = db.doc(`users/${event.params.userId}/metadata/tagStats`)
  await db.runTransaction(async transaction => {
    const notes = await transaction.get(notesRef)
    const previous = await transaction.get(statsRef)
    const counts = {}, rootCounts = {}
    let untagged = 0
    for (const note of notes.docs) {
      const data = note.data()
      const tags = [...new Set((Array.isArray(data.hashtags) ? data.hashtags : []).filter(tag => typeof tag === 'string' && tag))]
      if (!tags.length) untagged++
      for (const tag of tags) counts[tag] = (counts[tag] || 0) + 1
      for (const root of new Set(tags.map(tag => tag.split('/')[0]).filter(Boolean))) rootCounts[root] = (rootCounts[root] || 0) + 1
      if (note.id === event.params.noteId) {
        const expectedSearchTerms = searchTerms(data.title, tags)
        const expectedTagPaths = tagPaths(tags)
        if (!sameArray(data.searchTerms, expectedSearchTerms) || !sameArray(data.tagPaths, expectedTagPaths) || data.isUntagged !== (tags.length === 0)) {
          transaction.update(note.ref, { searchTerms: expectedSearchTerms, tagPaths: expectedTagPaths, isUntagged: tags.length === 0 })
        }
      }
    }
    const next = { counts, rootCounts, totalNotes: notes.docs.length, untagged }
    const old = previous.exists ? previous.data() : {}
    const equalMap = (a = {}, b = {}) => Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(key => a[key] === b[key])
    if (old.totalNotes !== next.totalNotes || old.untagged !== next.untagged || !equalMap(old.counts, counts) || !equalMap(old.rootCounts, rootCounts)) {
      transaction.set(statsRef, { ...next, updatedAt: new Date().toISOString() })
    }
  })
})

function referencedBy(data, assetId) {
  return Array.isArray(data?.assets) && data.assets.some(asset => asset?.id === assetId)
}

// Draft fields are untrusted. Resolve the Storage owner through Admin-managed claims,
// then accept only the exact current upload layout (never legacy or arbitrary paths).
async function validatedDraftPaths(ownerId, draftId, data) {
  const segment = value => typeof value === 'string' && /^[A-Za-z0-9_-]+$/.test(value)
  if (!segment(data.noteId) || !segment(data.assetId) || draftId !== data.assetId) return null
  const match = /^users\/([^/]+)\/notes\/([^/]+)\/images\/([^/]+)\.(webp|jpg)$/.exec(data.storagePath || '')
  if (!match || match[2] !== data.noteId || match[3] !== data.assetId || data.thumbnailPath) return null
  const user = await getAuth().getUser(match[1])
  if (user.disabled || (user.uid !== ownerId && user.customClaims?.investUid !== ownerId)) return null
  return [`users/${user.uid}/notes/${data.noteId}/images/${data.assetId}.${match[4]}`]
}

export const cleanupKmsImageDrafts = onSchedule({
  schedule: 'every monday 03:00',
  timeZone: 'Asia/Taipei',
  region: 'asia-east1',
  retryCount: 1,
}, async () => {
  if (!kmsImageCleanupEnabled.value()) {
    console.info('KMS image cleanup is disabled; no Firestore or Storage reads/writes were performed.')
    return
  }

  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
  const drafts = await db.collectionGroup('imageUploadDrafts').where('createdAt', '<', cutoff).limit(200).get()
  const bucket = getStorage().bucket()

  for (const draft of drafts.docs) {
    const match = /^users\/([^/]+)\/imageUploadDrafts\/([^/]+)$/.exec(draft.ref.path)
    const data = draft.data()
    if (!match || !data.noteId || !data.assetId) {
      continue
    }
    let paths
    try {
      paths = await validatedDraftPaths(match[1], match[2], data)
    } catch {
      // Missing/deleted identities and Auth failures are never evidence of an orphan.
      continue
    }
    if (!paths) continue
    const [note, body, trash] = await Promise.all([
      db.doc(`users/${match[1]}/notes/${data.noteId}`).get(),
      db.doc(`users/${match[1]}/noteBodies/${data.noteId}`).get(),
      db.doc(`users/${match[1]}/trash/${data.noteId}`).get(),
    ])
    const referenced = [note, body, trash].some(snapshot => snapshot.exists && referencedBy(snapshot.data(), data.assetId))
    if (!referenced) {
      const deletions = await Promise.allSettled(paths
        .map(path => bucket.file(path).delete({ ignoreNotFound: true })))
      if (deletions.some(result => result.status === 'rejected')) {
        console.error('孤兒圖片刪除失敗，保留草稿供下次重試', draft.ref.path)
        continue
      }
    }
    await draft.ref.delete()
  }
})
