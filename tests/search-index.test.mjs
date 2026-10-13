import test from 'node:test'
import assert from 'node:assert/strict'
import { compile, read } from './helpers/compile.mjs'
import { entryFor, packEntries, bucketFor, updateSearchNote, handleSearchEvent, RETRY_WINDOW_MS } from '../firebase-functions/search-index.js'

function backend() {
  const store = new Map([['kmsSearch/u/state/manifest', { schema: 1, status: 'ready', buckets: {}, totalNotes: 0 }]])
  let writes = 0
  const db = { doc: path => path, runTransaction: async work => {
    let writing = false
    await work({ get: async path => { assert.equal(writing, false); return { exists: store.has(path), data: () => structuredClone(store.get(path)) } }, set: (path, data) => { writing = true; writes++; store.set(path, data) }, delete: path => { writing = true; writes++; store.delete(path) }, update: (path, data) => { writing = true; writes++; const target = store.get(path); for (const [key, value] of Object.entries(data)) { if (key.startsWith('buckets.')) target.buckets[key.slice(8)] = value; else target[key] = value } } })
  } }
  return { store, db, writes: () => writes }
}
test('index transactions handle duplicates, current body and deletions with orphan prose', async () => {
  const { db, store, writes } = backend()
  store.set('users/u/notes/n', { title: 'title' }); store.set('users/u/noteBodies/n', { content: 'needle' })
  await updateSearchNote(db, 'u', 'n'); const count = writes()
  await updateSearchNote(db, 'u', 'n'); assert.equal(writes(), count)
  store.delete('users/u/notes/n'); await updateSearchNote(db, 'u', 'n')
  assert.equal(store.get('kmsSearch/u/state/manifest').totalNotes, 0)
})
test('expired retry is acknowledged and index becomes visibly degraded', async () => {
  const { db, store } = backend(), now = Date.now()
  await handleSearchEvent(db, { id: 'fixture', time: new Date(now - RETRY_WINDOW_MS - 1).toISOString(), params: { userId: 'u', noteId: 'n' } }, now)
  assert.equal(store.get('kmsSearch/u/state/manifest').status, 'degraded')
})
function clientHarness(count = 106) {
  const { cache } = compile(read('src/lib/cache.ts')), documents = new Map(), entries = Array.from({ length: count }, (_, i) => entryFor(String(i), { title: 'title' }, { content: `needle-${i}` }))
  const buckets = {}, state = { reads: 0, uid: 'u', fail: false, missing: false }
  for (const bucket of '0123456789abcdef') {
    const rows = entries.filter(entry => bucketFor(entry.note.id) === bucket)
    if (!rows.length) continue
    buckets[bucket] = { version: bucket, pages: [bucket] }
    documents.set(`kmsSearch/u/fulltextShards/${bucket}`, { version: bucket, data: packEntries(rows)[0] })
  }
  const manifest = { schema: 1, status: 'ready', totalNotes: count, updatedAt: '2026-09-11', buckets }
  const mod = compile(read('src/lib/kmsFullTextIndex.ts'), {
    ...compile(read('src/lib/kmsSearch.ts')), cache, kmsDB: {}, doc: (_, path) => path,
    captureUserSession: () => { const uid = state.uid; return { uid, assertActive: () => { if (state.uid !== uid) throw Error('account changed') } } },
    getDocFromServer: async path => { state.reads++; if (state.fail) throw Error('offline'); const value = path.endsWith('/manifest') ? manifest : documents.get(path); return { exists: () => Boolean(value) && !state.missing, data: () => value } },
  })
  return { mod, state, manifest, documents, cache }
}
test('106 notes search in one action costs 17 reads; subsequent keyword zero; unchanged refresh one', async () => {
  const { mod, state } = clientHarness()
  const result = await mod.searchKmsFullText('needle-105')
  assert.equal(result.scanned, 106); assert.equal(result.rows[0].id, '105'); assert.equal(state.reads, 17)
  assert.equal((await mod.searchKmsFullText('needle-99')).readAttempts, 0); assert.equal(state.reads, 17)
  mod.invalidateKmsFullText(); assert.equal((await mod.searchKmsFullText('needle')).readAttempts, 1)
})
test('degraded, missing and offline indices fail closed and can retry', async () => {
  for (const mode of ['degraded', 'missing', 'offline']) {
    const { mod, state, manifest } = clientHarness(1)
    if (mode === 'degraded') manifest.status = 'degraded'
    if (mode === 'missing') state.missing = true
    if (mode === 'offline') state.fail = true
    await assert.rejects(mod.searchKmsFullText('needle'))
    manifest.status = 'ready'; state.missing = false; state.fail = false
    assert.equal((await mod.searchKmsFullText('needle')).rows.length, 1)
  }
})
test('gzip pages preserve rich Unicode prose without truncating long queries', async () => {
  const entry = entryFor('n', { title: 'a' }, { contentDoc: { content: [{ text: 'ＡＢＣ 正文' }, { text: '尾端'.repeat(100) }] } })
  const { mod } = clientHarness(0)
  assert.deepEqual(await mod.decodeSearchPages(packEntries([entry], 17)), [entry])
})
