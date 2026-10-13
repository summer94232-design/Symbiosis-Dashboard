import test from 'node:test'
import assert from 'node:assert/strict'
import { compile, read } from './helpers/compile.mjs'
function harness(event = { title: 'event', googleEventId: 'occurrence' }) {
  let row = event, auth = { refreshToken: 'fixture', calendarId: 'calendar' }, active = true
  let reply = { deleted: 1, failed: 0 }, remoteError, beforeCommit
  const requests = [], order = []
  const session = { doc: (_, collection, id) => `${collection}/${id}`, assertActive: () => { if (!active) throw Error('account changed') } }
  const snap = data => ({ exists: () => !!data, data: () => structuredClone(data) })
  const mod = compile(read('src/lib/googleCalendar.ts'), {
 investAuth:{get currentUser(){return {uid:typeof state==='object'?state.uid:undefined,getIdToken:async()=> 'fixture-id-token'}}},
    investDB: {}, captureUserSession: () => session,
    getDoc: async ref => snap(ref.startsWith('settings/') ? auth : row),
    fetch: async (_, options) => { requests.push(JSON.parse(options.body)); order.push('remote'); if (remoteError) throw remoteError; return { ok: true, json: async () => reply } },
    runTransaction: async (_, fn) => { beforeCommit?.(); await fn({ get: async () => snap(row), delete: () => { row = null; order.push('local') } }) },
  })
  return { run: () => mod.deleteCalendarEventWithGoogle('event'), requests, order, row: () => row,
    fail: value => { remoteError = value }, reply: value => { reply = value }, disconnect: () => { auth = null },
    beforeCommit: fn => { beforeCommit = fn }, switchAccount: () => { active = false }, edit: () => { row.title = 'changed' } }
}
test('linked occurrence deletes exact Google event before local document, even without sync type selection', async () => {
  const h = harness(); await h.run()
  assert.deepEqual(h.order, ['remote', 'local'])
  assert.deepEqual(h.requests[0].deleteGoogleEventIds, ['occurrence'])
  assert.deepEqual(h.requests[0].events, [])
  assert.equal(h.requests[0].calendarId, 'calendar')
})
test('unlinked event deletes locally without Google request', async () => {
  const h = harness({ title: 'local' }); await h.run(); assert.equal(h.requests.length, 0); assert.equal(h.row(), null)
})
test('network failure preserves linked event and retry can finish', async () => {
  const h = harness(); h.fail(Error('offline')); await assert.rejects(h.run, /系統行程已保留/)
  assert.ok(h.row()); h.fail(null); await h.run(); assert.equal(h.row(), null)
})
test('failed or ambiguous Google result and missing authorization never remove local event', async () => {
  for (const response of [{ deleted: 0, failed: 1 }, {}, { deleted: 1, failed: 1 }]) {
    const h = harness(); h.reply(response); await assert.rejects(h.run); assert.ok(h.row())
  }
  const h = harness(); h.disconnect(); await assert.rejects(h.run, /重新授權/); assert.ok(h.row()); assert.equal(h.requests.length, 0)
})
test('concurrent edit and account switch prevent local deletion', async () => {
  for (const action of ['edit', 'switchAccount']) {
    const h = harness(); h.beforeCommit(h[action]); await assert.rejects(h.run); assert.ok(h.row())
  }
})
