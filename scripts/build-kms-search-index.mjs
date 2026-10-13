import { applicationDefault, initializeApp, deleteApp } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'

import { randomUUID } from 'node:crypto'
import { bucketFor, updateSearchNote, unpackEntries } from '../firebase-functions/search-index.js'

const args = process.argv.slice(2)
const arg = name => args.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3)
const projectId = arg('project'), uid = arg('user')
const maxNotes = Number(arg('max-notes') || 5000)
if (!projectId || !uid || uid.includes('/') || !Number.isSafeInteger(maxNotes) || maxNotes < 1) throw new Error('Required: --project=<KMS project> --user=<investUid> [--max-notes=5000] [--commit]')
const app = initializeApp({ credential: applicationDefault(), projectId })
const db = getFirestore(app)
let heldLease
try {

  const notes = db.collection(`users/${uid}/notes`)
  const ref = db.doc(`kmsSearch/${uid}/state/manifest`)
  const count = (await notes.count().get()).data().count
  console.log(`Project ${projectId}; user ${uid}; ${count} notes. Initial build reads current sources and rewrites affected compressed shards. Cost includes transaction reads, retries and writes.`)
  if (count > maxNotes) throw new Error(`Count exceeds --max-notes=${maxNotes}; no index writes performed.`)
  if (!args.includes('--commit')) { console.log('Dry run complete. No正文 reads or writes. Deploy both index triggers and rules before --commit.'); }
  else {
    const existing = await ref.get()
    if (existing.exists && existing.data().status === 'ready') throw new Error('Index already ready. Refusing an unnecessary full scan.')
    const token = randomUUID()
    await db.runTransaction(async tx => {
      const snapshot = await tx.get(ref)
      if (snapshot.exists && (snapshot.data().status === 'ready' || snapshot.data().leaseUntil > Date.now())) throw new Error('Index is ready or another builder holds the lease; retry after lease expiry.')
      tx.set(ref, { schema: 1, buckets: {}, totalNotes: 0, ...(snapshot.exists ? snapshot.data() : {}), status: 'building', lease: token, leaseUntil: Date.now() + 3600000 }, { merge: true })
    })
    heldLease = { db, ref, token }
    // The manifest exists before scanning: concurrent source writes are maintained by triggers.
    // Resume does not clear shards, so deletion events and late deliveries remain idempotent.
    const snapshot = await notes.select().limit(maxNotes + 1).get()
    if (snapshot.size > maxNotes) throw new Error('Notes grew beyond the build budget; index remains building.')
    const allIds = new Set(snapshot.docs.map(note => note.id))
    const currentManifest = (await ref.get()).data()
    for (const bucket of Object.values(currentManifest.buckets)) {
      const pages = []
      for (const id of bucket.pages) {
        const page = await db.doc(`kmsSearch/${uid}/fulltextShards/${id}`).get()
        if (!page.exists) throw new Error('Index changed during repair; retry.')
        pages.push(page.data().data)
      }
      if (pages.length) for (const entry of unpackEntries(pages)) allIds.add(entry.note.id)
    }
    if (allIds.size > maxNotes) throw new Error('Repair exceeds note budget.')
    let done = 0
    for (const bucket of '0123456789abcdef') {
      const ids = [...allIds].filter(id => bucketFor(id) === bucket)
      for (let offset = 0; offset < ids.length; offset += 40) {
        const chunk = ids.slice(offset, offset + 40)
        await updateSearchNote(db, uid, chunk)
        done += chunk.length
        console.log(`Indexed ${done}/${snapshot.size}`)
      }
    }
    await db.runTransaction(async tx => {
      const snapshot = await tx.get(ref)
      if (snapshot.data().lease !== token) throw new Error('Builder lease changed; refusing to publish.')
      if (snapshot.data().failureAt !== existing.data()?.failureAt) throw new Error('New failed event during build; retry repair.')
      tx.update(ref, { status: 'ready', leaseUntil: 0, updatedAt: new Date().toISOString() })
    })
    console.log('Index ready. Subsequent changes are maintained by the deployed triggers.')
  }
} catch (error) {
  if (heldLease) {
    const { db, ref, token } = heldLease
    await db.runTransaction(async tx => {
      const snapshot = await tx.get(ref)
      if (snapshot.exists && snapshot.data().lease === token && snapshot.data().status === 'building') tx.update(ref, { leaseUntil: 0 })
    }).catch(() => console.error('Unable to release builder lease; retry after its expiry.'))
  }
  throw error
} finally { await deleteApp(app) }
