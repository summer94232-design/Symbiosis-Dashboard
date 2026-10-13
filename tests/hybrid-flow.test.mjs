import test from 'node:test'
import assert from 'node:assert/strict'
import { compile, read } from './helpers/compile.mjs'
const toLocalDateString = value => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(value ?? new Date())
const policy = compile(read('src/lib/pricePolicy.ts'), { toLocalDateString })
const hybrid = compile(read('src/lib/hybridQuotes.ts'), { ...policy, ...compile(read('src/lib/quoteTiming.ts')) })
const snapshot = compile(read('src/lib/fubonSnapshotPolicy.ts'), policy)
const { createPriceRefreshCoordinator } = compile(read('src/lib/priceRefresh.ts'))
const at = '2026-09-24T06:00:00.000Z', date = '2026-09-24'
const observation = (price, sourceDate = date) => ({ price, requestedAt: at, fetchedAt: at,
    sourceDate, sourceUpdatedAt: null, priceType: 'trade', status: 'success' })
function shared(bindings) {
    return compile(read('src/lib/sharedQuotes.ts'), { ...policy, ...hybrid,
        isFubonSnapshotEnabled: () => true, ...bindings }).getSharedQuoteObservations
}

test('global mixed flow splits foreign/index codes, deduplicates requests and retains daily reference provenance', async () => {
    const calls = []
    const get = shared({
        getFubonSnapshotObservations: async codes => {
            calls.push(['fubon', codes])
            return snapshot.normalizeFubonSnapshots([{ date, data: codes.map(symbol => ({ symbol, closePrice: 100 })) }], codes, at, at)
        },
        getMultipleQuoteObservations: async codes => { calls.push(['fugle', codes]); return Object.fromEntries(codes.map(code => [code, observation(200)])) },
        getForeignQuotes: async codes => { calls.push(['foreign', codes]); return { AAPL: 250, '7203.T': 2700 } },
    })
    let saved = {}
    const run = createPriceRefreshCoordinator(async () => ['2330', '6488', 'IX0001', 'US:AAPL', 'JP:7203'], async codes => {
        saved = policy.mergeQuoteObservations(saved, await get(codes, at, 'global', ['2330']))
        return { prices: policy.getUsablePrices(saved) }
    })
    const first = run(['2330']), second = run(['6488'])
    assert.equal(first, second)
    await first
    assert.deepEqual(calls.find(c => c[0] === 'fubon')[1], ['2330', '6488'])
    assert.deepEqual(calls.find(c => c[0] === 'fugle')[1], ['IX0001', '2330'])
    assert.deepEqual(calls.find(c => c[0] === 'foreign')[1], ['AAPL', '7203.T'])
    assert.equal(saved['2330'], 200)
    assert.equal(saved._quotes['6488'].priceType, 'reference')
    assert.deepEqual(policy.stalePriceCodes(['2330', '6488'], saved, date), [])
    assert.deepEqual(policy.stalePriceCodes(['2330'], saved, date), [])
    assert.deepEqual(policy.stalePriceCodes(['2330'], saved, '2026-09-25'), ['2330'])
})

test('direct additions and disabled flag bypass market snapshots', async () => {
    for (const [enabled, mode] of [[true, 'direct'], [false, 'global']]) {
        let snapshotReads = 0, directReads = 0
        const get = shared({ isFubonSnapshotEnabled: () => enabled,
            getFubonSnapshotObservations: async () => { snapshotReads++; return {} },
            getMultipleQuoteObservations: async codes => { directReads++; return Object.fromEntries(codes.map(c => [c, observation(100)])) },
        })
        assert.equal((await get(['2330', '2330'], at, mode))['2330'].price, 100)
        assert.equal(snapshotReads, 0)
        assert.equal(directReads, 1)
    }
})

test('market outage bounds nonholding gaps while keeping held-stock confirmation and old-price safety', async () => {
    const codes = Array.from({ length: 25 }, (_, i) => String(1000 + i))
    const requested = []
    const get = shared({
        getFubonSnapshotObservations: async () => { throw Error('fixture outage') },
        getMultipleQuoteObservations: async list => { requested.push(...list); return Object.fromEntries(list.map(c => [c, observation(90)])) },
    })
    const quotes = await get([...codes, 'IX0001'], at, 'global', codes.slice(20))
    assert.equal(requested.length, 16) // 5 held codes + 10 other gaps + index
    const saved = policy.mergeQuoteObservations({ 1015: 123 }, quotes)
    assert.equal(saved[1015], 123) // historical number is retained but cannot be used
    assert.equal(policy.getUsablePrices(saved)[1015], undefined)
    assert.equal(quotes[1015].status, 'failed')
    assert.deepEqual(policy.stalePriceCodes(['1015'], saved, date), ['1015'])
})

test('an older trade cannot replace the current dated reference used for the daily trend', async () => {
    const get = shared({
        getFubonSnapshotObservations: async () => ({ 2330: { ...observation(100), priceType: 'reference' } }),
        getMultipleQuoteObservations: async () => ({ 2330: observation(120, '2026-09-23') }),
    })
    const saved = policy.mergeQuoteObservations({}, await get(['2330'], at, 'global', ['2330']))
    assert.equal(saved['2330'], 100)
    assert.equal(saved._quotes['2330'].priceType, 'reference')
    assert.deepEqual(policy.stalePriceCodes(['2330'], saved, date), [])
})

test('intraday refresh confirms all 13 held trades even with old market references and a ten-code gap limit', async () => {
    const held = ['00631L', '4958', '2308', '6182', '2317', '2383', '3711', '2454', '3037', '2409', '2330', '2327', '3481']
    const intraday = '2026-09-30T02:00:00.000Z', today = '2026-09-30'
    const calls = []
    const get = shared({
        getFubonSnapshotObservations: async codes => snapshot.normalizeFubonSnapshots([{
            date: '2026-09-29', data: codes.map(symbol => ({ symbol, closePrice: 100 })),
        }], codes, intraday, intraday),
        getMultipleQuoteObservations: async codes => {
            calls.push(codes)
            return Object.fromEntries(codes.map(code => [code, { ...observation(120, today), requestedAt: intraday, fetchedAt: intraday }]))
        },
    })
    const saved = policy.mergeQuoteObservations({}, await get(held, intraday, 'global', held))
    assert.deepEqual(calls, [held])
    assert.deepEqual(policy.stalePriceCodes(held, saved, today), [])
    assert.ok(held.every(code => saved[code] === 120 && saved._quotes[code].priceType === 'trade'))
})
