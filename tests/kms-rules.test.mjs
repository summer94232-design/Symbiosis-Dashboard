import { after, before, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { assertFails, assertSucceeds, initializeTestEnvironment } from '@firebase/rules-unit-testing'

const projectId = 'demo-kms-rules'
const bucketUrl = `gs://${projectId}.appspot.com`
let env

before(async () => {
  const [firestoreRules, storageRules] = await Promise.all([
    readFile(new URL('../firestore.kms.rules', import.meta.url), 'utf8'),
    readFile(new URL('../storage.kms.rules', import.meta.url), 'utf8'),
  ])
  env = await initializeTestEnvironment({
    projectId,
    firestore: { host: '127.0.0.1', port: 8085, rules: firestoreRules },
    storage: { host: '127.0.0.1', port: 9195, rules: storageRules },
  })
})

beforeEach(async () => {
  await Promise.all([env.clearFirestore(), env.clearStorage()])
  await env.withSecurityRulesDisabled(async context => {
    await context.firestore().doc('uidMappings/kms-alice').set({ investUid: 'invest-alice' })
  })
})

after(async () => {
  await env?.cleanup()
})

test('KMS UID 對照後可原子寫入自己的摘要與正文', async () => {
  const db = env.authenticatedContext('kms-alice', { investUid: 'invest-alice' }).firestore()
  const batch = db.batch()
  batch.set(db.doc('users/invest-alice/notes/note-1'), { title: '摘要', createdAt: '2026-01-01' })
  batch.set(db.doc('users/invest-alice/noteBodies/note-1'), { content: '完整正文', assets: [] })
  await assertSucceeds(batch.commit())

  const [summary, body] = await Promise.all([
    db.doc('users/invest-alice/notes/note-1').get(),
    db.doc('users/invest-alice/noteBodies/note-1').get(),
  ])
  assert.equal(summary.data().title, '摘要')
  assert.equal(body.data().content, '完整正文')
})

test('未對照使用者、其他使用者與未登入者均不可讀取私人資料', async () => {
  await env.withSecurityRulesDisabled(async context => {
    await context.firestore().doc('users/invest-alice/notes/private-note').set({ title: '私人筆記' })
  })

  await assertFails(env.authenticatedContext('kms-bob').firestore().doc('users/invest-alice/notes/private-note').get())
  await assertFails(env.authenticatedContext('invest-bob').firestore().doc('users/invest-alice/notes/private-note').get())
  await assertFails(env.unauthenticatedContext().firestore().doc('users/invest-alice/notes/private-note').get())
})

test('前端不能讀取、建立或竄改 UID 對照', async () => {
  const db = env.authenticatedContext('kms-alice', { investUid: 'invest-alice' }).firestore()
  await assertFails(db.doc('uidMappings/kms-alice').get())
  await assertFails(db.doc('uidMappings/kms-alice').set({ investUid: 'invest-bob' }))
  await assertFails(db.doc('uidMappings/kms-bob').get())
})

test('Storage 只允許本人路徑與規定大小的圖片', async () => {
  const alice = env.authenticatedContext('kms-alice', { investUid: 'invest-alice' }).storage(bucketUrl)
  const bob = env.authenticatedContext('kms-bob').storage(bucketUrl)
  const imagePath = 'users/invest-alice/notes/note-1/images/image.webp'

  await assertSucceeds(alice.ref(imagePath).put(new Uint8Array(1024), { contentType: 'image/webp' }))
  await assertFails(bob.ref(imagePath).getDownloadURL())
  await assertFails(alice.ref('users/invest-alice/notes/note-1/images/large.webp')
    .put(new Uint8Array(2 * 1024 * 1024 + 1), { contentType: 'image/webp' }))
  await assertFails(alice.ref('users/invest-alice/notes/note-1/thumbnails/large.webp')
    .put(new Uint8Array(300 * 1024 + 1), { contentType: 'image/webp' }))
})

test('文件上限與舊全域路徑唯讀規則有效', async () => {
  const alice = env.authenticatedContext('kms-alice').storage(bucketUrl)
  await assertSucceeds(alice.ref('users/kms-alice/notes/note-1/files/report.pdf')
    .put(new Uint8Array(1024), { contentType: 'application/pdf' }))
  await assertFails(alice.ref('users/kms-alice/notes/note-1/files/large.pdf')
    .put(new Uint8Array(50 * 1024 * 1024 + 1), { contentType: 'application/pdf' }))
  await assertFails(alice.ref('images/new-global.webp').put(new Uint8Array(10), { contentType: 'image/webp' }))

  await env.withSecurityRulesDisabled(async context => {
    await context.storage(bucketUrl).ref('images/legacy.webp').put(new Uint8Array(10), { contentType: 'image/webp' })
  })
  await assertSucceeds(alice.ref('images/legacy.webp').getDownloadURL())
  await assertFails(alice.ref('images/legacy.webp').delete())
})
