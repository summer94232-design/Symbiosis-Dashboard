import { applicationDefault, initializeApp } from 'firebase-admin/app'
import { FieldPath, getFirestore } from 'firebase-admin/firestore'

function option(name, fallback = '') {
  const prefix = `--${name}=`
  return process.argv.find(value => value.startsWith(prefix))?.slice(prefix.length) || fallback
}

const projectId = option('project', process.env.KMS_FIREBASE_PROJECT_ID)
const commit = process.argv.includes('--commit')
const selectedUser = option('user')
if (!projectId) throw new Error('請提供 --project=<kms-project-id>')

const app = initializeApp({ credential: applicationDefault(), projectId }, 'kms-metadata-rebuild')
const db = getFirestore(app)

function normalize(value) {
  return String(value || '').normalize('NFKC').trim().toLocaleLowerCase('zh-TW').replace(/\s+/g, '')
}

function buildTerms(title, hashtags) {
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

function buildPaths(hashtags) {
  const paths = new Set()
  hashtags.forEach(tag => {
    const parts = String(tag).split('/').map(part => part.trim()).filter(Boolean)
    parts.forEach((_, index) => paths.add(parts.slice(0, index + 1).join('/')))
  })
  return [...paths]
}

const perUser = new Map()
const snapshot = await db.collectionGroup('notes').orderBy(FieldPath.documentId()).get()
let batch = db.batch()
let batchWrites = 0
let indexed = 0

async function flush() {
  if (commit && batchWrites) await batch.commit()
  batch = db.batch()
  batchWrites = 0
}

for (const note of snapshot.docs) {
  const match = /^users\/([^/]+)\/notes\/([^/]+)$/.exec(note.ref.path)
  if (!match || (selectedUser && selectedUser !== match[1])) continue
  const data = note.data()
  const hashtags = Array.isArray(data.hashtags) ? data.hashtags : []
  const stats = perUser.get(match[1]) || { counts: {}, rootCounts: {}, totalNotes: 0, untagged: 0 }
  stats.totalNotes += 1
  if (!hashtags.length) stats.untagged += 1
  hashtags.forEach(tag => { stats.counts[tag] = (stats.counts[tag] || 0) + 1 })
  ;[...new Set(hashtags.map(tag => String(tag).split('/')[0]).filter(Boolean))]
    .forEach(tag => { stats.rootCounts[tag] = (stats.rootCounts[tag] || 0) + 1 })
  perUser.set(match[1], stats)

  if (commit) {
    batch.update(note.ref, {
      searchTerms: buildTerms(data.title || '', hashtags),
      tagPaths: buildPaths(hashtags),
      isUntagged: hashtags.length === 0,
    })
    batchWrites += 1
    if (batchWrites >= 400) await flush()
  }
  indexed += 1
}

if (commit) {
  for (const [userId, stats] of perUser) {
    batch.set(db.doc(`users/${userId}/metadata/tagStats`), { ...stats, updatedAt: new Date().toISOString() })
    batchWrites += 1
    if (batchWrites >= 400) await flush()
  }
  await flush()
}

console.log(JSON.stringify({ mode: commit ? 'commit' : 'dry-run', indexed, users: Object.fromEntries(perUser) }, null, 2))
