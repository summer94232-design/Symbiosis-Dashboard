import test from 'node:test'
import assert from 'node:assert/strict'
import { compile, read } from './helpers/compile.mjs'

const isPositivePrice = value => typeof value === 'number' && Number.isFinite(value) && value > 0
const quoteTiming = compile(read('src/lib/quoteTiming.ts'))
const hybrid = compile(read('src/lib/hybridQuotes.ts'), { isPositivePrice, ...quoteTiming })
const policy = compile(read('src/lib/fubonSnapshotPolicy.ts'), { isPositivePrice })
const marketHours = compile(read('src/lib/marketHours.ts'))
const at = '2026-09-23T02:00:00.000Z'
const observation = (price, sourceDate = '2026-09-23') => ({
    price, requestedAt: at, fetchedAt: at, sourceDate, sourceUpdatedAt: null,
    priceType: price === null ? 'missing' : 'trade', status: price === null ? 'failed' : 'success',
})

function timedSnapshot(latency) {
    const timers = []
    const mod = compile(read('src/lib/fubonSnapshot.ts').replace('import.meta.env.VITE_FUBON_SNAPSHOT_ENABLED', "'true'"), {
        ...policy, ...quoteTiming,
        captureUserSession: () => ({ assertActive() {} }),
        AbortSignal: { timeout: delay => {
            const controller = new AbortController()
            timers.push({ at: delay, run: () => controller.abort() })
            return controller.signal
        } },
        authenticatedFetch: (_path, _session, options) => new Promise((resolve, reject) => {
            options.signal.addEventListener('abort', () => reject(new Error('snapshot timeout')), { once: true })
            timers.push({ at: latency, run: () => resolve({ json: async () => ({ snapshots: [{ market: 'TSE', date: '2026-09-23',
                fetchedAt: at, data: [{ symbol: '2330', lastPrice: 120, closePrice: 119, isTrial: false }] }] }) }) })
        }),
    })
    return { mod, timers }
}

test('a successful ten-second market snapshot survives startup instead of triggering bounded Fugle gaps', async () => {
    const h = timedSnapshot(10102)
    const pending = h.mod.getFubonSnapshotObservations(['2330'], at).then(value => ({ value }), error => ({ error }))
    const first = h.timers.sort((a, b) => a.at - b.at)[0]
    first.run()
    const result = await pending
    assert.equal(result.error, undefined)
    assert.equal(result.value['2330'].status, 'success')
    assert.equal(result.value['2330'].price, 120)
})

test('a hanging market snapshot still times out before the shared refresh deadline', async () => {
    const h = timedSnapshot(30000)
    const pending = h.mod.getFubonSnapshotObservations(['2330'], at).then(value => ({ value }), error => ({ error }))
    const first = h.timers.sort((a, b) => a.at - b.at)[0]
    assert.ok(first.at < quoteTiming.QUOTE_REFRESH_TIMEOUT_MS)
    first.run()
    assert.match((await pending).error.message, /timeout/)
})

test('documented market response uses unflagged closePrice only as a reference and rejects trial prices', () => {
    const result = policy.normalizeFubonSnapshots([{
        market: 'TSE', date: '2026-09-23', data: [
            { symbol: '2330', lastPrice: 120, closePrice: 119, isTrial: false },
            { symbol: '0050', lastPrice: 99, closePrice: 98, isTrial: true },
            { symbol: '2317', closePrice: 80 },
            { symbol: '2603' },
            { symbol: '9999', lastPrice: 50, isTrial: false },
        ],
    }], ['2330', '0050', '2317', '2603'], at, at)
    assert.equal(result['2330'].price, 120)
    assert.equal(result['2330'].priceType, 'trade')
    assert.equal(result['2330'].sourceUpdatedAt, null)
    assert.equal(result['0050'].status, 'failed')
    assert.equal(result['2317'].price, 80)
    assert.equal(result['2317'].priceType, 'reference')
    assert.equal(result['2317'].status, 'success')
    assert.equal(result['2603'].status, 'failed')
    assert.equal(result['9999'], undefined)
})

test('hybrid refresh keeps successful market prices and limits Fugle calls to gaps and IX0001', async () => {
    const calls = []
    const readers = {
        snapshot: async codes => {
            calls.push(['market', codes])
            return { 2330: observation(120), 2317: observation(null) }
        },
        fugle: async codes => {
            calls.push(['fugle', codes])
            return Object.fromEntries(codes.map(code => [code, observation(code === 'IX0001' ? 27000 : 80)]))
        },
    }
    const result = await hybrid.readHybridTaiwanQuotes(['2330', '2317', '0050', 'IX0001', '2330'], at, readers, 1)
    assert.deepEqual(calls, [['market', ['2330', '2317', '0050']], ['fugle', ['IX0001']], ['fugle', ['2317']]])
    assert.equal(result.quotes['2330'].price, 120)
    assert.equal(result.quotes['2317'].price, 80)
    assert.equal(result.quotes['0050'].status, 'failed')
    assert.deepEqual(result.unattempted, ['0050'])
})

test('market outage does not trigger an unbounded Fugle refresh', async () => {
    const requested = []
    const result = await hybrid.readHybridTaiwanQuotes(['2330', '2317', '0050', 'IX0001'], at, {
        snapshot: async () => { throw Error('unavailable') },
        fugle: async codes => { requested.push(...codes); return Object.fromEntries(codes.map(code => [code, observation(100)])) },
    }, 1)
    assert.deepEqual(requested, ['IX0001', '2330'])
    assert.deepEqual(result.unattempted, ['2317', '0050'])
    assert.equal(result.quotes['2317'].status, 'failed')
    assert.equal(result.snapshotError, '富邦快照暫時無法使用')
})

test('Taiwan closing check uses the market timezone and waits ten minutes', () => {
    assert.equal(marketHours.isAfterTaiwanClose(new Date('2026-09-24T05:39:00Z')), false)
    assert.equal(marketHours.isAfterTaiwanClose(new Date('2026-09-24T05:40:00Z')), true)
    assert.equal(marketHours.isAfterTaiwanClose(new Date('2026-09-26T06:00:00Z')), false)
})

test('after close, held codes use confirmed Fugle trades without losing market reference fallback', async () => {
    const calls = []
    const readers = {
        snapshot: async () => ({ 2330: { ...observation(100), priceType: 'reference' },
            2317: { ...observation(80), priceType: 'reference' } }),
        fugle: async codes => {
            calls.push(codes)
            return { 2330: observation(101), 2317: observation(82, '2026-09-22') }
        },
    }
    const result = await hybrid.readHybridTaiwanQuotes(['2330', '2317'], at, readers, 10, ['2330', '2317'])
    assert.deepEqual(calls, [['2330', '2317']])
    assert.equal(result.quotes['2330'].price, 101)
    assert.equal(result.quotes['2330'].priceType, 'trade')
    assert.equal(result.quotes['2317'].price, 80)
    assert.equal(result.quotes['2317'].priceType, 'reference')
    assert.deepEqual(result.unattempted, [])
})

test('old-date market quotes trigger bounded repair and today trades replace them', async () => {
    const requested = []
    const codes = ['2330', '2317', '0050']
    const result = await hybrid.readHybridTaiwanQuotes(codes, at, {
        snapshot: async () => Object.fromEntries(codes.map(code => [code, observation(100, '2026-09-22')])),
        fugle: async list => { requested.push(...list); return Object.fromEntries(list.map(code => [code, observation(120)])) },
    }, 1, ['0050'])
    assert.deepEqual(requested, ['0050', '2330'])
    assert.equal(result.quotes['2330'].price, 120)
    assert.equal(result.quotes['0050'].sourceDate, '2026-09-23')
    assert.equal(result.quotes['2317'].sourceDate, '2026-09-22')
    assert.deepEqual(result.unattempted, ['2317'])
})

test('same-day confirmation cannot regress a known source tick', async () => {
    const result = await hybrid.readHybridTaiwanQuotes(['2330'], at, {
        snapshot: async () => ({ 2330: { ...observation(120), sourceUpdatedAt: 200 } }),
        fugle: async () => ({ 2330: { ...observation(110), sourceUpdatedAt: 100 } }),
    }, 10, ['2330'])
    assert.equal(result.quotes['2330'].price, 120)
})

function deferred() {
    let resolve
    const promise = new Promise(done => { resolve = done })
    return { promise, resolve }
}

test('a reference-only holding waits for source selection rather than authorizing an early conflicting valuation', async () => {
    const market = deferred(), published = []
    const pending = hybrid.readHybridTaiwanQuotes(['2330'], at, {
        snapshot: () => market.promise,
        fugle: async (_codes, _at, _deadline, onQuote) => {
            const result = { 2330: { ...observation(50), priceType: 'reference' } }
            await onQuote(result)
            return result
        },
    }, 10, ['2330'], quotes => { published.push(quotes) })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(published.length, 0)
    market.resolve({ 2330: { ...observation(80), priceType: 'reference' } })
    assert.equal((await pending).quotes['2330'].price, 80)
})

test('holding/index requests start before the snapshot completes and bounded gaps do not wait for them', async () => {
    const market = deferred(), priority = deferred(), repair = deferred()
    const calls = []
    const pending = hybrid.readHybridTaiwanQuotes(['2330', '2317', '0050', 'IX0001'], at, {
        snapshot: codes => { calls.push(['market', codes]); return market.promise },
        fugle: codes => { calls.push(['fugle', codes]); return codes.includes('2330') ? priority.promise : repair.promise },
    }, 1, ['2330', '2330', 'outside'])
    assert.deepEqual(calls, [['market', ['2330', '2317', '0050']], ['fugle', ['IX0001', '2330']]])
    market.resolve({ 2330: observation(100), 2317: observation(null), '0050': observation(null) })
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(calls.at(-1), ['fugle', ['2317']])
    repair.resolve({ 2317: observation(80) })
    let finished = false
    pending.then(() => { finished = true })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(finished, false) // Still wait for confirmation before publishing the saved batch.
    priority.resolve({ 2330: observation(120), IX0001: observation(27000) })
    const result = await pending
    assert.equal(result.quotes['2330'].price, 120)
    assert.equal(result.quotes['2317'].price, 80)
    assert.deepEqual(result.unattempted, ['0050'])
    assert.equal(calls.filter(call => call[0] === 'fugle').flatMap(call => call[1]).filter(code => code === '2330').length, 1)
})

test('failure of either parallel complement preserves the other source and market fallback', async () => {
    for (const failPriority of [true, false]) {
        const result = await hybrid.readHybridTaiwanQuotes(['2330', '2317', 'IX0001'], at, {
            snapshot: async () => ({ 2330: { ...observation(100), priceType: 'reference' } }),
            fugle: codes => {
                if (codes.includes('2330') === failPriority) throw Error('fixture unavailable')
                return Promise.resolve(Object.fromEntries(codes.map(code => [code, observation(120)])))
            },
        }, 1, ['2330'])
        assert.equal(result.quotes['2330'].price, failPriority ? 100 : 120)
        assert.equal(result.quotes['2317'].status, failPriority ? 'success' : 'failed')
    }
})

test('empty market and index-only requests avoid unused provider calls', async () => {
    for (const codes of [[], ['IX0001', 'IX0001']]) {
        const calls = []
        const result = await hybrid.readHybridTaiwanQuotes(codes, at, {
            snapshot: async () => { throw Error('must not read market') },
            fugle: async list => { calls.push(list); return { IX0001: observation(27000) } },
        })
        assert.deepEqual(calls, codes.length ? [['IX0001']] : [])
        assert.equal(Object.keys(result.quotes).length, codes.length ? 1 : 0)
    }
})

test('a slow market snapshot leaves proxy time for bounded gap repairs', async () => {
    let time = Date.parse(at), started = time, deadline
    const withClock = compile(read('src/lib/hybridQuotes.ts'), { isPositivePrice, ...quoteTiming, Date: class extends Date { static now() { return time } } })
    const result = await withClock.readHybridTaiwanQuotes(['2330'],at,{
        snapshot: async () => { time += 8000; throw new Error('market timeout') },
        fugle: async (_codes,_at,bound) => { deadline=bound; assert.ok(time+20000<=bound); return {'2330':observation(120)} },
    })
    assert.equal(deadline,started+60000)
    assert.equal(result.quotes['2330'].price,120)
})
