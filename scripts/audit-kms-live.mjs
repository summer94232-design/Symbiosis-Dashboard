import { readFile } from 'node:fs/promises'
import { cert, initializeApp } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'
import { getStorage } from 'firebase-admin/storage'

function option(name, fallback = '') {
  const prefix = `--${name}=`
  return process.argv.find(value => value.startsWith(prefix))?.slice(prefix.length) || fallback
}

const projectId = option('project')
const credentialsPath = option('credentials')
const bucketName = option('bucket')
const users = process.argv.filter(value => value.startsWith('--user=')).map(value => value.slice(7))

if (!projectId || !credentialsPath || !bucketName || users.length === 0) {
  throw new Error('請提供 --project、--credentials、--bucket 與至少一個 --user')
}

const credential = cert(JSON.parse(await readFile(credentialsPath, 'utf8')))
const app = initializeApp({ credential, projectId, storageBucket: bucketName }, 'kms-live-audit')
const db = getFirestore(app)
const bucket = getStorage(app).bucket(bucketName)

async function listFileCount(prefix) {
  let pageToken
  let count = 0
  do {
    const [files, , response] = await bucket.getFiles({ prefix, maxResults: 1000, pageToken, autoPaginate: false })
    count += files.length
    pageToken = response?.nextPageToken
  } while (pageToken)
  return count
}

const report = { projectId, bucketName, users: [] }
for (const userId of users) {
  const [notes, bodies, trash, stats, privateFiles] = await Promise.all([
    db.collection(`users/${userId}/notes`).get(),
    db.collection(`users/${userId}/noteBodies`).get(),
    db.collection(`users/${userId}/trash`).get(),
    db.doc(`users/${userId}/metadata/tagStats`).get(),
    listFileCount(`users/${userId}/notes/`),
  ])
  const bodyIds = new Set(bodies.docs.map(document => document.id))
  const missingCreatedAt = notes.docs.filter(document => !document.get('createdAt')).map(document => document.id)
  const missingBodies = notes.docs.filter(document => !bodyIds.has(document.id)).map(document => document.id)
  const legacyInlineBodies = notes.docs.filter(document => {
    const data = document.data()
    return typeof data.content === 'string' || data.contentDoc || Array.isArray(data.assets)
  }).map(document => document.id)
  const thumbnailSummaries = notes.docs.filter(document => {
    const data = document.data()
    return Boolean(data.coverThumbnailUrl || data.articleThumbnailUrl)
  }).length
  const missingSearchMetadata = notes.docs.filter(document => {
    const data = document.data()
    return !Array.isArray(data.searchTerms) || !Array.isArray(data.tagPaths) || typeof data.isUntagged !== 'boolean'
  }).map(document => document.id)
  const statsData = stats.exists ? stats.data() : {}

  report.users.push({
    userId,
    notes: notes.size,
    noteBodies: bodies.size,
    trash: trash.size,
    tagStatsExists: stats.exists,
    tagStatsTotalNotes: Number(statsData.totalNotes) || 0,
    tagStatsTagCount: Object.keys(statsData.counts || {}).length,
    tagStatsRootCount: Object.keys(statsData.rootCounts || {}).length,
    tagStatsUntagged: Number(statsData.untagged) || 0,
    privateStorageFiles: privateFiles,
    thumbnailSummaries,
    missingSearchMetadataCount: missingSearchMetadata.length,
    missingSearchMetadataIds: missingSearchMetadata.slice(0, 20),
    missingCreatedAtCount: missingCreatedAt.length,
    missingCreatedAtIds: missingCreatedAt.slice(0, 20),
    missingBodiesCount: missingBodies.length,
    missingBodyIds: missingBodies.slice(0, 20),
    legacyInlineBodiesCount: legacyInlineBodies.length,
    legacyInlineBodyIds: legacyInlineBodies.slice(0, 20),
  })
}

const [legacyImages, legacyFiles] = await Promise.all([
  listFileCount('images/'),
  listFileCount('files/'),
])
report.legacyStorage = { images: legacyImages, files: legacyFiles }

console.log(JSON.stringify(report, null, 2))
