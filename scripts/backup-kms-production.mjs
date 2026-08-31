import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, relative, resolve } from 'node:path'
import { cert, initializeApp } from 'firebase-admin/app'
import { getAuth } from 'firebase-admin/auth'
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
const mappings = process.argv
  .filter(value => value.startsWith('--map='))
  .map(value => value.slice(6).split(':'))
  .filter(([kmsUid, investUid]) => kmsUid && investUid)

if (!projectId || !credentialsPath || !bucketName || users.length === 0) {
  throw new Error('請提供 --project、--credentials、--bucket 與至少一個 --user')
}

const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
const outputRoot = resolve(option('output', `migration-backups/production-kms-backup-${timestamp}`))
const credential = cert(JSON.parse(await readFile(resolve(credentialsPath), 'utf8')))
const app = initializeApp({ credential, projectId, storageBucket: bucketName }, `kms-production-backup-${timestamp}`)
const db = getFirestore(app)
const auth = getAuth(app)
const bucket = getStorage(app).bucket(bucketName)
const collections = ['notes', 'noteBodies', 'trash', 'metadata', 'settings', 'imageUploadDrafts']

function encode(value) {
  if (value === null || value === undefined || typeof value !== 'object') return value
  if (value instanceof Date) return { __type: 'date', value: value.toISOString() }
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return { __type: 'bytes', value: Buffer.from(value).toString('base64') }
  if (typeof value.toDate === 'function' && Number.isFinite(value.seconds)) {
    return { __type: 'timestamp', seconds: value.seconds, nanoseconds: value.nanoseconds || 0 }
  }
  if (Number.isFinite(value.latitude) && Number.isFinite(value.longitude)) {
    return { __type: 'geopoint', latitude: value.latitude, longitude: value.longitude }
  }
  if (typeof value.path === 'string' && value.firestore) return { __type: 'reference', path: value.path }
  if (Array.isArray(value)) return value.map(encode)
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, encode(item)]))
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(encode(value), null, 2), 'utf8')
}

const manifest = {
  formatVersion: 1,
  projectId,
  bucketName,
  createdAt: new Date().toISOString(),
  mode: 'read-only-logical-backup',
  users: {},
  uidMappings: {},
  authUsers: {},
  storage: [],
}

for (const userId of users) {
  manifest.users[userId] = {}
  for (const collectionName of collections) {
    const snapshot = await db.collection(`users/${userId}/${collectionName}`).get()
    const documents = Object.fromEntries(snapshot.docs.map(document => [document.id, document.data()]))
    manifest.users[userId][collectionName] = snapshot.size
    await writeJson(resolve(outputRoot, 'firestore', 'users', userId, `${collectionName}.json`), documents)
  }
}

for (const [kmsUid, investUid] of mappings) {
  const mapping = await db.doc(`uidMappings/${kmsUid}`).get()
  manifest.uidMappings[kmsUid] = mapping.exists ? mapping.data() : null
  try {
    const user = await auth.getUser(kmsUid)
    manifest.authUsers[kmsUid] = {
      uid: user.uid,
      email: user.email || null,
      disabled: user.disabled,
      customClaims: user.customClaims || {},
      providerData: user.providerData.map(provider => ({ providerId: provider.providerId, uid: provider.uid, email: provider.email || null })),
      investUid,
    }
  } catch (error) {
    manifest.authUsers[kmsUid] = { error: error instanceof Error ? error.message : String(error), investUid }
  }
}
await writeJson(resolve(outputRoot, 'firestore', 'uidMappings.json'), manifest.uidMappings)
await writeJson(resolve(outputRoot, 'auth', 'users.json'), manifest.authUsers)

const prefixes = [
  ...mappings.map(([kmsUid]) => `users/${kmsUid}/notes/`),
  'images/',
  'files/',
]
for (const prefix of prefixes) {
  const [files] = await bucket.getFiles({ prefix })
  for (const file of files) {
    const destination = resolve(outputRoot, 'storage', ...file.name.split('/'))
    const storageRoot = resolve(outputRoot, 'storage')
    if (!destination.startsWith(`${storageRoot}\\`) && destination !== storageRoot) throw new Error(`不安全的 Storage 路徑：${file.name}`)
    await mkdir(dirname(destination), { recursive: true })
    await file.download({ destination })
    const [metadata] = await file.getMetadata()
    manifest.storage.push({
      name: file.name,
      size: Number(metadata.size) || 0,
      contentType: metadata.contentType || null,
      md5Hash: metadata.md5Hash || null,
      crc32c: metadata.crc32c || null,
    })
  }
}

await writeJson(resolve(outputRoot, 'manifest.json'), manifest)

async function listFiles(directory) {
  const result = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) result.push(...await listFiles(path))
    else if (entry.isFile() && entry.name !== 'SHA256SUMS.txt') result.push(path)
  }
  return result
}

const checksums = []
for (const path of (await listFiles(outputRoot)).sort()) {
  const digest = createHash('sha256').update(await readFile(path)).digest('hex')
  checksums.push(`${digest}  ${relative(outputRoot, path).replaceAll('\\', '/')}`)
}
await writeFile(resolve(outputRoot, 'SHA256SUMS.txt'), `${checksums.join('\n')}\n`, 'utf8')

console.log(JSON.stringify({
  output: outputRoot,
  users: manifest.users,
  uidMappings: Object.keys(manifest.uidMappings).length,
  authUsers: Object.keys(manifest.authUsers).length,
  storageFiles: manifest.storage.length,
  checksummedFiles: checksums.length,
}, null, 2))
