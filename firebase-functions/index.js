import { initializeApp } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'
import { getStorage } from 'firebase-admin/storage'
import { onDocumentWritten } from 'firebase-functions/v2/firestore'
import { defineBoolean } from 'firebase-functions/params'
import { onSchedule } from 'firebase-functions/v2/scheduler'

initializeApp()
const db = getFirestore()
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
  retry: false,
}, async event => {
  const before = event.data?.before.exists ? event.data.before.data() : null
  const after = event.data?.after.exists ? event.data.after.data() : null
  const beforeTags = Array.isArray(before?.hashtags) ? before.hashtags : []
  const afterTags = Array.isArray(after?.hashtags) ? after.hashtags : []

  if (after) {
    const expectedSearchTerms = searchTerms(after.title, afterTags)
    const expectedTagPaths = tagPaths(afterTags)
    if (!sameArray(after.searchTerms, expectedSearchTerms) ||
        !sameArray(after.tagPaths, expectedTagPaths) ||
        after.isUntagged !== (afterTags.length === 0)) {
      await event.data.after.ref.update({
        searchTerms: expectedSearchTerms,
        tagPaths: expectedTagPaths,
        isUntagged: afterTags.length === 0,
      })
    }
  }

  if (JSON.stringify(beforeTags) === JSON.stringify(afterTags) && Boolean(before) === Boolean(after)) return
  const statsRef = db.doc(`users/${event.params.userId}/metadata/tagStats`)
  await db.runTransaction(async transaction => {
    const snapshot = await transaction.get(statsRef)
    const stats = snapshot.exists ? snapshot.data() : {}
    const counts = { ...(stats.counts || {}) }
    const rootCounts = { ...(stats.rootCounts || {}) }
    const apply = (map, key, delta) => {
      const next = (Number(map[key]) || 0) + delta
      if (next > 0) map[key] = next
      else delete map[key]
    }
    beforeTags.forEach(tag => apply(counts, tag, -1))
    afterTags.forEach(tag => apply(counts, tag, 1))
    ;[...new Set(beforeTags.map(tag => String(tag).split('/')[0]).filter(Boolean))].forEach(tag => apply(rootCounts, tag, -1))
    ;[...new Set(afterTags.map(tag => String(tag).split('/')[0]).filter(Boolean))].forEach(tag => apply(rootCounts, tag, 1))
    transaction.set(statsRef, {
      counts,
      rootCounts,
      totalNotes: Math.max(0, (Number(stats.totalNotes) || 0) + (after ? 1 : 0) - (before ? 1 : 0)),
      untagged: Math.max(0, (Number(stats.untagged) || 0) + (after && afterTags.length === 0 ? 1 : 0) - (before && beforeTags.length === 0 ? 1 : 0)),
      updatedAt: new Date().toISOString(),
    })
  })
})

function referencedBy(data, assetId) {
  return Array.isArray(data?.assets) && data.assets.some(asset => asset?.id === assetId)
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
      await draft.ref.delete()
      continue
    }
    const [note, body, trash] = await Promise.all([
      db.doc(`users/${match[1]}/notes/${data.noteId}`).get(),
      db.doc(`users/${match[1]}/noteBodies/${data.noteId}`).get(),
      db.doc(`users/${match[1]}/trash/${data.noteId}`).get(),
    ])
    const referenced = [note, body, trash].some(snapshot => snapshot.exists && referencedBy(snapshot.data(), data.assetId))
    if (!referenced) {
      const deletions = await Promise.allSettled([data.storagePath, data.thumbnailPath]
        .filter(Boolean)
        .map(path => bucket.file(path).delete({ ignoreNotFound: true })))
      if (deletions.some(result => result.status === 'rejected')) {
        console.error('孤兒圖片刪除失敗，保留草稿供下次重試', draft.ref.path)
        continue
      }
    }
    await draft.ref.delete()
  }
})
