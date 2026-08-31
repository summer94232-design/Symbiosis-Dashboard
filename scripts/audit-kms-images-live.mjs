import { extname } from 'node:path'
import { readFile } from 'node:fs/promises'
import { cert, initializeApp } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'
import { getStorage } from 'firebase-admin/storage'
import sharp from 'sharp'

function option(name, fallback = '') {
  const prefix = `--${name}=`
  return process.argv.find(value => value.startsWith(prefix))?.slice(prefix.length) || fallback
}

const projectId = option('project')
const credentialsPath = option('credentials')
const bucketName = option('bucket')
const mappings = process.argv
  .filter(value => value.startsWith('--map='))
  .map(value => value.slice(6).split(':'))
  .filter(([kmsUid, investUid]) => kmsUid && investUid)

if (!projectId || !credentialsPath || !bucketName || mappings.length === 0) {
  throw new Error('請提供 --project、--credentials、--bucket 與至少一個 --map=<kmsUid>:<investUid>')
}

const credential = cert(JSON.parse(await readFile(credentialsPath, 'utf8')))
const app = initializeApp({ credential, projectId, storageBucket: bucketName }, 'kms-live-image-audit')
const db = getFirestore(app)
const bucket = getStorage(app).bucket(bucketName)
const report = { projectId, bucketName, users: [] }

for (const [kmsUid, investUid] of mappings) {
  const [files, bodies] = await Promise.all([
    bucket.getFiles({ prefix: `users/${kmsUid}/notes/` }).then(([rows]) => rows),
    db.collection(`users/${investUid}/noteBodies`).get(),
  ])
  const assets = bodies.docs.flatMap(document => {
    const rows = document.data().assets
    return Array.isArray(rows) ? rows.map(asset => ({ ...asset, noteId: document.id })) : []
  })
  const fileByName = new Map(files.map(file => [file.name, file]))
  const auditedAssets = []

  for (const asset of assets) {
    if (!asset?.storagePath || !asset?.thumbnailPath) continue
    const mainFile = fileByName.get(asset.storagePath)
    const thumbnailFile = fileByName.get(asset.thumbnailPath)
    const [mainMetadata, thumbnailMetadata, mainBuffer, thumbnailBuffer] = await Promise.all([
      mainFile?.getMetadata().then(([metadata]) => metadata),
      thumbnailFile?.getMetadata().then(([metadata]) => metadata),
      mainFile?.download().then(([buffer]) => buffer),
      thumbnailFile?.download().then(([buffer]) => buffer),
    ])
    const [mainImage, thumbnailImage] = await Promise.all([
      mainBuffer ? sharp(mainBuffer).metadata() : null,
      thumbnailBuffer ? sharp(thumbnailBuffer).metadata() : null,
    ])
    const mainSize = Number(mainMetadata?.size) || 0
    const thumbnailSize = Number(thumbnailMetadata?.size) || 0
    auditedAssets.push({
      noteId: asset.noteId,
      originalExtension: extname(asset.originalName || '').toLowerCase() || null,
      storedMimeType: mainMetadata?.contentType || asset.mimeType || null,
      main: {
        exists: Boolean(mainFile),
        sizeBytes: mainSize,
        width: mainImage?.width || asset.width || 0,
        height: mainImage?.height || asset.height || 0,
        withinTarget: mainSize <= 1.5 * 1024 * 1024 && Math.max(mainImage?.width || 0, mainImage?.height || 0) <= 2048,
      },
      thumbnail: {
        exists: Boolean(thumbnailFile),
        sizeBytes: thumbnailSize,
        width: thumbnailImage?.width || 0,
        height: thumbnailImage?.height || 0,
        withinTarget: thumbnailSize <= 180 * 1024 && Math.max(thumbnailImage?.width || 0, thumbnailImage?.height || 0) <= 480,
      },
    })
  }

  report.users.push({
    investUid,
    kmsUid,
    storageFiles: files.length,
    mainImages: files.filter(file => file.name.includes('/images/')).length,
    thumbnails: files.filter(file => file.name.includes('/thumbnails/')).length,
    otherFiles: files.filter(file => file.name.includes('/files/')).length,
    firestoreAssets: assets.length,
    auditedAssets,
    unreferencedStorageFiles: files.filter(file => !assets.some(asset => asset.storagePath === file.name || asset.thumbnailPath === file.name)).length,
  })
}

console.log(JSON.stringify(report, null, 2))
