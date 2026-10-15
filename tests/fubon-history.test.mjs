import test from 'node:test'
import assert from 'node:assert/strict'
import { handleFubonHistory } from '../netlify/functions/fubon-history.js'
import { reserveQuoteBudget } from '../netlify/lib/quote-budget.js'
const input = { symbol: '2330', from: '2026-10-01', to: '2026-10-15' }
const event = value => ({ body: JSON.stringify(value), httpMethod: 'POST', headers: {} })
function fixture() {
    const calls = []
    return { calls, deps: {
        authorizeApiIdentity: async () => ({ db: {} }),
        reserveQuoteBudget: async (_db, _count, _now, pool) => { calls.push(pool); return { granted: 1 } },
        cachedApi: async (_key, _ttl, loader) => loader(),
        readFubonHistory: async () => ({ secret: 'private', data: [{ date: '2026-10-01', open: 100, high: 110, low: 90, close: 105, volume: 1000, secret: 'private' }] }),
    } }
}
test('history authentication runs before SDK access and malformed/long ranges are rejected', async () => {
    const f = fixture()
    assert.equal((await handleFubonHistory(event(input), { ...f.deps, authorizeApiIdentity: async () => ({ statusCode: 401 }) })).statusCode, 401)
    for (const value of [{ ...input, from: '2026-02-30' }, { ...input, from: '2025-10-15' }, { ...input, symbol: '../../secret' }]) {
        assert.equal((await handleFubonHistory(event(value), f.deps)).statusCode, 400)
    }
    assert.equal(f.calls.length, 0)
})
test('history response preserves OHLC/volume only and uses a separate provider pool', async () => {
    const f = fixture(), result = await handleFubonHistory(event(input), f.deps)
    assert.equal(result.statusCode, 200); assert.deepEqual(f.calls, ['fubonHistory'])
    assert.ok(!result.body.includes('private')); assert.ok(!result.body.includes('secret'))
    assert.equal(JSON.parse(result.body).data[0].close, 105)
})
test('quota denial and upstream failure never become successful empty history', async () => {
    const f = fixture()
    const denied = await handleFubonHistory(event(input), { ...f.deps, reserveQuoteBudget: async () => ({ granted: 0, retryAfter: 70 }) })
    assert.equal(denied.statusCode, 429); assert.equal(denied.headers['Retry-After'], '70')
    const failed = await handleFubonHistory(event(input), { ...f.deps, readFubonHistory: async () => { throw Error('private-key') } })
    assert.equal(failed.statusCode, 502); assert.ok(!failed.body.includes('private-key'))
})
test('quote, Fugle history and Fubon history keep independent cross-device rolling budgets', async () => {
    const records = new Map()
    const db = { doc: path => path, runTransaction: async fn => fn({ get: async path => ({ data: () => records.get(path) }), set: (path, value) => records.set(path, value) }) }
    assert.equal((await reserveQuoteBudget(db, 55, 1000, 'history')).granted, 55)
    assert.equal((await reserveQuoteBudget(db, 1, 1001, 'history')).granted, 0)
    assert.equal((await reserveQuoteBudget(db, 20, 1001, 'quote')).granted, 20)
    assert.equal((await reserveQuoteBudget(db, 55, 1001, 'fubonHistory')).granted, 55)
    assert.equal(records.size, 3)
})
