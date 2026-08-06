import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import { applicationDefault, initializeApp } from 'firebase-admin/app'
import { getAuth } from 'firebase-admin/auth'
import { FieldPath, getFirestore } from 'firebase-admin/firestore'
import { getDownloadURL, getStorage } from 'firebase-admin/storage'
import sharp from 'sharp'

function option(name, fallback = '') {
  const prefix = `--${name}=`
  return process.argv.find(value => value.startsWith(prefix))?.slice(prefix.length) || fallback
}

function flag(name) {
  return process.argv.includes(`--${name}`)
}

const projectId = option('project', process.env.KMS_FIREBASE_PROJECT_ID)
const storageBucket = option('bucket', process.env.KMS_FIREBASE_STORAGE_BUCKET)
const commit = flag('commit')
const allowSameUid = flag('allow-same-uid')
const selectedUser = option('user')
const pageSize = Math.min(100, Math.max(1, Number(option('page-size', '40')) || 40))
const mappings = process.argv
  .filter(value => value.startsWith('--map='))
  .map(value => value.slice('--map='.length).split(':'))
  .filter(([kmsUid, investUid]) => kmsUid && investUid)

if (!projectId || !storageBucket) {
  throw new Error('請提供 --project=<kms-project-id> 與 --bucket=<kms-storage-bucket>')
}

const app = initializeApp({ credential: applicationDefault(), projectId, storageBucket }, 'kms-migration')
const db = getFirestore(app)
const bucket = getStorage(app).bucket(storageBucket)
const report = {
  projectId,
  storageBucket,
  startedAt: new Date().toISOString(),
  mode: commit ? 'commit' : 'dry-run',
  scanned: 0,
  pending: 0,
  migrated: 0,
  skipped: 0,
  failed: [],
  orphanBodies: [],
  notes: [],
}
const outputDir = resolve(option('output', 'migration-backups'))
await mkdir(outputDir, { recursive: true })
const outputFile = resolve(outputDir, `kms-migration-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
const checkpoint = () => writeFile(outputFile, JSON.stringify(report, null, 2), 'utf8')
await checkpoint()

const auth = getAuth(app)
for (const [kmsUid, investUid] of mappings) {
  const user = await auth.getUser(kmsUid)
  if (commit) {
    await auth.setCustomUserClaims(kmsUid, { ...(user.customClaims || {}), investUid })
    await db.doc(`uidMappings/${kmsUid}`).set({ investUid, updatedAt: new Date().toISOString() })
  }
}

const mappingSnapshot = await db.collection('uidMappings').get()
const kmsUidByInvestUid = new Map(mappingSnapshot.docs.map(row => [row.data().investUid, row.id]))
for (const [kmsUid, investUid] of mappings) kmsUidByInvestUid.set(investUid, kmsUid)

function notePathParts(path) {
  const match = /^users\/([^/]+)\/notes\/([^/]+)$/.exec(path)
  return match ? { investUid: match[1], noteId: match[2] } : null
}

function storagePathFromUrl(url) {
  if (!url) return ''
  if (url.startsWith('gs://')) {
    const withoutScheme = url.slice(5)
    return withoutScheme.slice(withoutScheme.indexOf('/') + 1)
  }
  try {
    const parsed = new URL(url)
    const encodedPath = parsed.pathname.match(/\/o\/(.+)$/)?.[1]
    return encodedPath ? decodeURIComponent(encodedPath) : ''
  } catch {
    return ''
  }
}

async function readSource(url, storagePath = '') {
  const path = storagePath || storagePathFromUrl(url)
  if (path) {
    const [buffer] = await bucket.file(path).download()
    return { buffer, path }
  }
  const response = await fetch(url)
  if (!response.ok) throw new Error(`舊附件下載失敗：HTTP ${response.status}`)
  return { buffer: Buffer.from(await response.arrayBuffer()), path: '' }
}

async function saveImageVariants(buffer, kmsUid, noteId, originalName) {
  const id = randomUUID()
  const image = sharp(buffer, { failOn: 'none' }).rotate()
  const [mainBuffer, thumbnailBuffer] = await Promise.all([
    image.clone().resize({ width: 2048, height: 2048, fit: 'inside', withoutEnlargement: true }).webp({ quality: 78 }).toBuffer(),
    image.clone().resize({ width: 480, height: 480, fit: 'inside', withoutEnlargement: true }).webp({ quality: 70 }).toBuffer(),
  ])
  const metadata = await sharp(mainBuffer).metadata()
  const storagePath = `users/${kmsUid}/notes/${noteId}/images/${id}.webp`
  const thumbnailPath = `users/${kmsUid}/notes/${noteId}/thumbnails/${id}.webp`
  const mainFile = bucket.file(storagePath)
  const thumbnailFile = bucket.file(thumbnailPath)
  const uploadMetadata = { contentType: 'image/webp', cacheControl: 'private,max-age=31536000,immutable' }
  await Promise.all([
    mainFile.save(mainBuffer, { resumable: false, metadata: uploadMetadata }),
    thumbnailFile.save(thumbnailBuffer, { resumable: false, metadata: uploadMetadata }),
  ])
  return {
    id,
    storagePath,
    thumbnailPath,
    downloadUrl: await getDownloadURL(mainFile),
    thumbnailUrl: await getDownloadURL(thumbnailFile),
    width: metadata.width || 0,
    height: metadata.height || 0,
    size: mainBuffer.length,
    thumbnailSize: thumbnailBuffer.length,
    mimeType: 'image/webp',
    originalName,
  }
}

async function copyFileToPrivatePath(url, kmsUid, noteId, originalName) {
  const source = await readSource(url)
  const safeName = basename(originalName || 'attachment').normalize('NFKC').replace(/[^\p{L}\p{N}._-]+/gu, '_').slice(-120)
  const storagePath = `users/${kmsUid}/notes/${noteId}/files/${randomUUID()}_${safeName}`
  const file = bucket.file(storagePath)
  await file.save(source.buffer, {
    resumable: false,
    metadata: { contentType: 'application/octet-stream', cacheControl: 'private,max-age=31536000,immutable' },
  })
  return { storagePath, downloadUrl: await getDownloadURL(file), oldPath: source.path }
}

function needsMigration(data) {
  return Boolean(
    data.content || data.contentDoc || (Array.isArray(data.assets) && data.assets.length) ||
    (data.imageUrl && !data.coverAssetId) || (data.fileUrl && !data.fileStoragePath),
  )
}

function searchMetadata(title, hashtags = []) {
  const normalize = value => String(value || '').normalize('NFKC').trim().toLocaleLowerCase('zh-TW').replace(/\s+/g, '')
  const terms = new Set()
  for (const source of [title, ...hashtags].map(normalize).filter(Boolean)) {
    for (let start = 0; start < source.length && terms.size < 300; start += 1) {
      for (let length = 1; length <= Math.min(12, source.length - start) && terms.size < 300; length += 1) {
        terms.add(source.slice(start, start + length))
      }
    }
  }
  const paths = new Set()
  hashtags.forEach(tag => {
    const parts = String(tag).split('/').map(part => part.trim()).filter(Boolean)
    parts.forEach((_, index) => paths.add(parts.slice(0, index + 1).join('/')))
  })
  return { searchTerms: [...terms], tagPaths: [...paths], isUntagged: hashtags.length === 0 }
}

let cursor = null
do {
  let notesQuery = db.collectionGroup('notes').orderBy(FieldPath.documentId()).limit(pageSize)
  if (cursor) notesQuery = notesQuery.startAfter(cursor)
  const snapshot = await notesQuery.get()
  if (snapshot.empty) break

  for (const noteSnapshot of snapshot.docs) {
    const parts = notePathParts(noteSnapshot.ref.path)
    if (!parts || (selectedUser && parts.investUid !== selectedUser)) continue
    report.scanned += 1
    const data = noteSnapshot.data()
    const existingBody = await db.doc(`users/${parts.investUid}/noteBodies/${parts.noteId}`).get()
    if (!needsMigration(data) && existingBody.exists) {
      report.skipped += 1
      continue
    }

    report.pending += 1
    report.notes.push({
      path: noteSnapshot.ref.path,
      summary: data,
      existingBody: existingBody.exists ? existingBody.data() : null,
    })
    // 在任何正式寫入之前，把原始摘要與正文落盤；中途中斷也能保留已掃描備份。
    await checkpoint()
    if (!commit) continue

    const kmsUid = kmsUidByInvestUid.get(parts.investUid) || (allowSameUid ? parts.investUid : '')
    if (!kmsUid) {
      report.failed.push({ path: noteSnapshot.ref.path, error: '缺少 KMS UID 對照；請使用 --map=<kmsUid>:<investUid>' })
      continue
    }

    const createdPaths = []
    try {
      const summary = { ...data, updatedAt: new Date().toISOString() }
      Object.assign(summary, searchMetadata(data.title, Array.isArray(data.hashtags) ? data.hashtags : []))
      const body = existingBody.exists
        ? { ...existingBody.data() }
        : { content: data.content || '', ...(data.contentDoc ? { contentDoc: data.contentDoc } : {}), assets: data.assets || [] }
      delete summary.content
      delete summary.contentDoc
      delete summary.assets

      let assets = Array.isArray(body.assets) ? [...body.assets] : []
      for (let index = 0; index < assets.length; index += 1) {
        const asset = assets[index]
        if (asset?.thumbnailUrl && asset?.thumbnailPath) continue
        const source = await readSource(asset.downloadUrl, asset.storagePath)
        const replacement = await saveImageVariants(source.buffer, kmsUid, parts.noteId, asset.originalName || `legacy-${asset.id}.jpg`)
        assets[index] = replacement
        createdPaths.push(replacement.storagePath, replacement.thumbnailPath)
        if (summary.coverAssetId === asset.id) summary.coverAssetId = replacement.id
      }

      if (summary.imageUrl && !summary.coverAssetId) {
        const source = await readSource(summary.imageUrl)
        const cover = await saveImageVariants(source.buffer, kmsUid, parts.noteId, `legacy-cover-${parts.noteId}.jpg`)
        assets.push(cover)
        summary.imageUrl = cover.downloadUrl
        summary.coverAssetId = cover.id
        summary.coverThumbnailUrl = cover.thumbnailUrl
        createdPaths.push(cover.storagePath, cover.thumbnailPath)
      }

      if (summary.fileUrl && !summary.fileStoragePath) {
        const copied = await copyFileToPrivatePath(summary.fileUrl, kmsUid, parts.noteId, summary.fileName)
        summary.fileUrl = copied.downloadUrl
        summary.fileStoragePath = copied.storagePath
        createdPaths.push(copied.storagePath)
      }

      body.assets = assets
      const cover = assets.find(asset => asset.id === summary.coverAssetId)
      const preview = assets.find(asset => asset.id !== summary.coverAssetId)
      if (cover?.thumbnailUrl) summary.coverThumbnailUrl = cover.thumbnailUrl
      if (preview?.thumbnailUrl) summary.articleThumbnailUrl = preview.thumbnailUrl

      const batch = db.batch()
      batch.set(noteSnapshot.ref, summary)
      batch.set(db.doc(`users/${parts.investUid}/noteBodies/${parts.noteId}`), body)
      await batch.commit()

      const [savedSummary, savedBody] = await Promise.all([
        noteSnapshot.ref.get(),
        db.doc(`users/${parts.investUid}/noteBodies/${parts.noteId}`).get(),
      ])
      if (!savedSummary.exists || !savedBody.exists || 'contentDoc' in savedSummary.data()) {
        throw new Error('遷移後核對失敗')
      }
      report.migrated += 1
      await checkpoint()
    } catch (error) {
      await Promise.allSettled(createdPaths.map(path => bucket.file(path).delete({ ignoreNotFound: true })))
      report.failed.push({ path: noteSnapshot.ref.path, error: error instanceof Error ? error.message : String(error) })
      await checkpoint()
    }
  }
  cursor = snapshot.docs.at(-1)
} while (cursor)

const bodySnapshots = await db.collectionGroup('noteBodies').get()
for (const bodySnapshot of bodySnapshots.docs) {
  const match = /^users\/([^/]+)\/noteBodies\/([^/]+)$/.exec(bodySnapshot.ref.path)
  if (!match || (selectedUser && match[1] !== selectedUser)) continue
  const [note, trash] = await Promise.all([
    db.doc(`users/${match[1]}/notes/${match[2]}`).get(),
    db.doc(`users/${match[1]}/trash/${match[2]}`).get(),
  ])
  if (!note.exists && !trash.exists) report.orphanBodies.push(bodySnapshot.ref.path)
}

report.finishedAt = new Date().toISOString()
await checkpoint()

console.log(JSON.stringify({
  mode: report.mode,
  scanned: report.scanned,
  pending: report.pending,
  migrated: report.migrated,
  skipped: report.skipped,
  failed: report.failed.length,
  orphanBodies: report.orphanBodies.length,
  backup: outputFile,
}, null, 2))

if (report.failed.length) process.exitCode = 2
