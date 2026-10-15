import test from 'node:test'
import assert from 'node:assert/strict'
import { compile, read } from './helpers/compile.mjs'
const history = compile(read('src/lib/historyCache.ts'))
const bar = date => ({ date, open: 100, high: 110, low: 90, close: 105, volume: 1000 })
const tick = () => new Promise(resolve => setImmediate(resolve))
function fixture(extra = {}) {
    const entries = new Map(), calls = [], fallback = []
    let clock = Date.parse('2026-10-16T09:00:00Z')
    const store = { get: async key => structuredClone(entries.get(key)), set: async row => entries.set(row.key, structuredClone(row)) }
    const options = { store, now: () => clock,
        primary: async (symbol, from, to) => { calls.push({ symbol, from, to }); return { data: [bar(from), ...(from === to ? [] : [bar(to)])] } },
        fallback: async (...args) => { fallback.push(args); throw Error('fallback offline') }, ...extra }
    return { entries, calls, fallback, options, store, get: history.createHistoryReader(options), advance: ms => { clock += ms } }
}
test('long and leap-year ranges are contiguous, nonoverlapping and strictly below one year', () => {
    const parts = history.splitHistoryRange('2020-02-28', '2026-10-16')
    assert.equal(parts[0].from, '2020-02-28'); assert.equal(parts.at(-1).to, '2026-10-16')
    for (let i = 0; i < parts.length; i++) {
        assert.ok(Date.parse(parts[i].to) - Date.parse(parts[i].from) < 365 * 86400000)
        if (i) assert.equal(Date.parse(parts[i].from) - Date.parse(parts[i - 1].to), 86400000)
    }
    assert.throws(() => history.splitHistoryRange('2026-02-30', '2026-10-01'))
})
test('MA and chart share coverage, including overlapping requests, and a new reader reuses persisted public bars', async () => {
    const f = fixture()
    const [ma, chart] = await Promise.all([f.get('2330', '2026-09-01', '2026-10-15'), f.get('2330', '2026-09-26', '2026-10-15')])
    assert.equal(f.calls.length, 1); assert.equal(ma.data.length, 2); assert.equal(chart.data.length, 1)
    const afterReload = history.createHistoryReader(f.options)
    assert.deepEqual(await afterReload('2330', '2026-09-01', '2026-10-15'), ma)
    assert.equal(f.calls.length, 1)
    assert.ok(!JSON.stringify([...f.entries.values()]).includes('token'))
})
test('100 cold symbols perform 100 reads; repeating uses cache, adding five performs only five more', async () => {
    const f = fixture()
    const symbols = Array.from({ length: 100 }, (_, i) => String(1000 + i))
    await Promise.all(symbols.map(s => f.get(s, '2026-09-01', '2026-10-15')))
    assert.equal(f.calls.length, 100)
    await Promise.all([...symbols, '2000', '2001', '2002', '2003', '2004'].map(s => f.get(s, '2026-09-01', '2026-10-15')))
    assert.equal(f.calls.length, 105)
})
test('new days fetch only uncovered dates, while old cached intervals are periodically revalidated', async () => {
    const f = fixture()
    await f.get('2330', '2026-09-01', '2026-10-14')
    await f.get('2330', '2026-09-01', '2026-10-15')
    assert.deepEqual(f.calls.at(-1), { symbol: '2330', from: '2026-10-15', to: '2026-10-15' })
    f.advance(86400000)
    await f.get('2330', '2026-09-01', '2026-10-15')
    assert.ok(f.calls.length > 2)
})
test('today is rechecked after five minutes; failures do not mark coverage successful', async () => {
    const f = fixture()
    await f.get('2330', '2026-10-16', '2026-10-16')
    await f.get('2330', '2026-10-16', '2026-10-16'); assert.equal(f.calls.length, 1)
    f.advance(300000)
    await f.get('2330', '2026-10-16', '2026-10-16'); assert.equal(f.calls.length, 2)
    const broken = fixture({ primary: async () => { throw Error('offline') } })
    await assert.rejects(broken.get('2330', '2026-10-01', '2026-10-15'))
    assert.equal(broken.entries.size, 0)
})
test('genuine empty periods are cached and invalid primary OHLC falls back with the same interval', async () => {
    const empty = fixture({ primary: async () => ({ data: [] }) })
    assert.deepEqual(await empty.get('2330', '2026-10-10', '2026-10-11'), { data: [] })
    assert.deepEqual(await empty.get('2330', '2026-10-10', '2026-10-11'), { data: [] })
    const fallback = []
    const f = fixture({ primary: async () => ({ data: [{ ...bar('2026-10-01'), high: 1 }] }),
        fallback: async (...args) => { fallback.push(args); return { data: [bar('2026-10-01')] } } })
    assert.equal((await f.get('2330', '2026-10-01', '2026-10-15')).data.length, 1)
    assert.deepEqual(fallback, [['2330', '2026-10-01', '2026-10-15']])
})
test('global history concurrency is bounded and queued work cannot follow an account switch', async () => {
    let active = 0, peak = 0, alive = true, release
    const pause = new Promise(resolve => { release = resolve })
    const f = fixture({ primary: async () => { peak = Math.max(peak, ++active); await pause; active--; return { data: [] } } })
    const assertActive = () => { if (!alive) throw Error('account changed') }
    const jobs = Array.from({ length: 10 }, (_, i) => f.get(String(1000 + i), '2026-10-01', '2026-10-15', assertActive))
    const result = Promise.allSettled(jobs)
    await tick(); assert.equal(peak, 3)
    alive = false; release()
    assert.ok((await result).every(row => row.status === 'rejected'))
    assert.equal(f.entries.size, 0); assert.equal(f.fallback.length, 0)
})
test('corrupt persisted bars never become successful cached history', async () => {
    const f = fixture()
    f.entries.set('daily:unadjusted:v1:2330', { key: 'daily:unadjusted:v1:2330', data: [{ ...bar('2026-10-01'), close: 0 }],
        coverage: [{ from: '2026-10-01', to: '2026-10-15', checkedAt: Date.parse('2026-10-16T09:00:00Z') }] })
    assert.equal((await f.get('2330', '2026-10-01', '2026-10-15')).data[0].close, 105)
    assert.equal(f.calls.length, 1)
})

test('unverified Fubon history remains disabled while the real consumer still gains shared Fugle caching', async () => {
    const f = fixture()
    let calls = 0
    const consumer = compile(read('src/lib/history.ts').replace('import.meta.env.VITE_FUBON_HISTORY_ENABLED', "'false'"), {
        ...history, createBrowserHistoryStore: () => f.store, isFubonSnapshotEnabled: () => true,
        captureUserSession: () => ({ assertActive() {} }),
        authenticatedFetch: () => assert.fail('Unverified account must not become primary'),
        getHistoricalCandles: async () => { calls++; return { data: [bar('2026-10-01')] } },
        readFugleHistory: async () => { calls++; return { data: [bar('2026-10-01')] } },
    })
    await consumer.getHistoricalCandles('2330', '2026-10-01', '2026-10-15')
    await consumer.getHistoricalCandles('2330', '2026-10-01', '2026-10-15')
    assert.equal(calls, 1)
})
