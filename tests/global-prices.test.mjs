import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { compile, read } from './helpers/compile.mjs'

const { createPriceRefreshCoordinator } = compile(read('src/lib/priceRefresh.ts'))
const universe = compile(read('src/lib/quoteUniverse.ts'))
const presentation = compile(read('src/lib/priceRefreshPresentation.ts'))
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
const tick = () => new Promise(resolve => setImmediate(resolve))

test('global universe includes unvisited pages, old sold stocks and distinct foreign market keys', () => {
    const codes = universe.collectQuoteCodes([
        [{ code: '2330' }, { code: '2317' }, { code: '2330' }],
        [{ code: '2330.TW' }, { code: '7203', market: 'jp' }, { code: 'AAPL', market: 'us' }],
        [{ code: '7203', market: 'TW' }, { code: '7203.T', market: 'JP' }, { code: '  ' }],
    ])
    assert.deepEqual(codes, ['2330', '2317', 'JP:7203', 'US:AAPL', '7203'])
})

test('legacy foreign symbols route to overseas quotes without duplicate prefixes or Taiwan requests', async () => {
    const codes = universe.collectQuoteCodes([
        [{ code: ' nvda ' }, { code: 'NVDA', market: 'us' }, { code: 'US:NVDA', market: 'US' }],
        [{ code: '2330.TW' }, { code: '00679B' }, { code: 'IX0001' }, { code: '7203', market: 'TW' }],
        [{ code: '7203.T' }, { code: 'JP:7203', market: 'JP' }, { code: 'BRK-B' }],
    ])
    assert.deepEqual(codes, ['US:NVDA', '2330', '00679B', 'IX0001', '7203', 'JP:7203', 'US:BRK-B'])
    assert.equal(universe.quoteKey('NVDA', ' TW '), 'NVDA', 'explicit market wins over inference')
    const calls = []
    const mod = compile(read('src/lib/sharedQuotes.ts'), {
        isPositivePrice: value => typeof value === 'number' && value > 0,
        isFubonSnapshotEnabled: () => false,
        getMultipleQuoteObservations: async symbols => { calls.push(['TW', symbols]); return {} },
        getForeignQuotes: async symbols => { calls.push(['foreign', symbols]); return { NVDA: 123 } },
    })
    const quotes = await mod.getSharedQuoteObservations(codes, 'now')
    assert.deepEqual(calls, [['TW', ['2330', '00679B', 'IX0001', '7203']], ['foreign', ['NVDA', '7203.T', 'BRK-B']]])
    assert.equal(quotes['US:NVDA'].price, 123)
})

test('global inventory reads are cached per account and collection invalidation includes newly added stocks', async () => {
    const { cache } = compile(read('src/lib/cache.ts'))
    let uid = 'A', newStock = false, reads = 0
    const mod = compile(read('src/lib/quoteUniverse.ts'), {
        cache, investDB: {}, captureUserSession: () => ({ uid, col: (_, name) => name, assertActive() {} }),
        fetchTrades: async () => [{ code: '2330' }, { code: '2317' }],
        getDocs: async name => {
            reads++
            const rows = name === 'watchlist' ? [{ code: 'AAPL', market: 'us' }, ...(newStock ? [{ code: '7203', market: 'jp' }] : [])]
                : name === 'sentiments' ? [{ code: '2330' }] : [{ code: '2454', market: 'TW' }]
            return { docs: rows.map((data, i) => ({ id: name === 'sentiments' ? 'record-' + i : data.code, data: () => data })) }
        },
    })
    assert.deepEqual(await mod.loadGlobalQuoteCodes(), ['2330', '2317', 'US:AAPL', '2454', 'IX0001'])
    await mod.loadGlobalQuoteCodes(); assert.equal(reads, 3)
    newStock = true; mod.invalidateQuoteUniverse()
    assert.ok((await mod.loadGlobalQuoteCodes()).includes('JP:7203')); assert.equal(reads, 6)
    uid = 'B'; await mod.loadGlobalQuoteCodes(); assert.equal(reads, 9)
})

test('holding quote verification reads inventory only and excludes sold or future holdings', async () => {
    const calc = compile(read('src/lib/calc.ts'))
    const mod = compile(read('src/lib/quoteUniverse.ts'), {
        ...calc, captureUserSession: () => ({ assertActive() {} }), toLocalDateString: () => '2026-10-01',
        fetchTrades: async () => [
            { id: '1', date: '2026-09-01', type: 'buy', code: '2330', name: 'fixture', shares: 100, price: 100, total: 10000 },
            { id: '2', date: '2026-09-02', type: 'buy', code: '2317', name: 'fixture', shares: 100, price: 100, total: 10000 },
            { id: '3', date: '2026-09-03', type: 'sell', code: '2317', name: 'fixture', shares: 100, price: 100, total: 10000 },
            { id: '4', date: '2026-10-02', type: 'buy', code: '2454', name: 'fixture', shares: 100, price: 100, total: 10000 },
        ],
        fetchDividends: async () => [], getDoc: () => assert.fail('No quote read'), fetchCashflow: () => assert.fail('No cash-flow read'),
    })
    assert.deepEqual(await mod.loadHoldingQuoteCodes(), ['2330'])
})

test('any entry refreshes the entire universe once; simultaneous entry and repeated clicks reuse requests', async () => {
    let clock = 1000, reads = 0
    const calls = [], wait = deferred()
    const run = createPriceRefreshCoordinator(async () => { reads++; return ['holding', 'old-sale', 'watch', 'sentiment', 'industry'] }, async codes => {
        calls.push(codes); await wait.promise
        return { prices: Object.fromEntries(codes.map(code => [code, 100])) }
    }, () => clock)
    const first = run(['holding']), second = run(['watch'])
    assert.equal(first, second)
    await tick(); wait.resolve()
    const result = await first
    assert.equal(calls.length, 1); assert.equal(reads, 1)
    assert.equal(Object.keys(result.prices).length, 5)
    clock += 20000; await run(['old-sale'])
    assert.equal(calls.length, 1)
    clock += 41000; await run(['holding'])
    assert.equal(calls.length, 2)
})

test('a new draft symbol joining during refresh is fetched once and every caller receives it', async () => {
    const wait = deferred(), calls = []
    const run = createPriceRefreshCoordinator(async () => ['2330'], async codes => {
        calls.push(codes)
        if (calls.length === 1) await wait.promise
        return { prices: Object.fromEntries(codes.map(code => [code, 100])) }
    })
    const a = run(); await tick()
    const b = run(['2317', '2330']); wait.resolve()
    const [first, second] = await Promise.all([a, b])
    assert.deepEqual(calls, [['2330'], ['2317']])
    assert.deepEqual(first, second)
    assert.equal(second.prices['2317'], 100)
})

test('partial retry refetches missing prices without refetching successful prices or prolonging their cache', async () => {
    let clock = 1000
    const calls = []
    const run = createPriceRefreshCoordinator(async () => ['2330', '2317'], async codes => {
        calls.push(codes)
        return { prices: Object.fromEntries(codes.map(code => [code, calls.length === 1 && code === '2317' ? null : 100])) }
    }, () => clock)
    await run(); clock += 40000; await run()
    assert.deepEqual(calls, [['2330', '2317'], ['2317']])
    clock += 21000; await run()
    assert.deepEqual(calls[2], ['2330'])
})

test('inventory read failures release the coordinator for retry without an incomplete global refresh', async () => {
    let fail = true, quotes = 0
    const run = createPriceRefreshCoordinator(async () => { if (fail) throw Error('offline'); return ['2330'] }, async () => { quotes++; return { prices: { 2330: 100 } } })
    await assert.rejects(run(), /offline/); assert.equal(quotes, 0)
    fail = false; await run(); assert.equal(quotes, 1)
})

test('foreign prices are shared observations and foreign failure does not discard Taiwan quotes', async () => {
    let fail = false
    const calls = []
    const mod = compile(read('src/lib/sharedQuotes.ts'), {
        isPositivePrice: value => typeof value === 'number' && value > 0,
        isFubonSnapshotEnabled: () => false,
        getMultipleQuoteObservations: async codes => { calls.push(codes); return { 2330: { price: 100, status: 'success' } } },
        getForeignQuotes: async symbols => { calls.push(symbols); if (fail) throw Error('foreign offline'); return { '7203.T': 2500, AAPL: 200 } },
    })
    const prices = await mod.getSharedQuoteObservations(['2330', 'JP:7203', 'US:AAPL', '2330'], 'now')
    assert.equal(prices['JP:7203'].price, 2500)
    assert.equal(prices['US:AAPL'].price, 200)
    assert.equal(prices['JP:7203'].sourceDate, '')
    assert.deepEqual(calls, [['2330'], ['7203.T', 'AAPL']])
    fail = true
    const partial = await mod.getSharedQuoteObservations(['2330', 'US:AAPL'], 'now')
    assert.equal(partial['2330'].price, 100)
    assert.equal(partial['US:AAPL'].status, 'failed')
})

test('enabled market snapshot changes only Taiwan batch pricing while foreign quotes retain their source', async () => {
    const calls = []
    const mod = compile(read('src/lib/sharedQuotes.ts'), {
        isFubonSnapshotEnabled: () => true,
        readHybridTaiwanQuotes: async (codes, requestedAt, readers, fallbackLimit, preciseCodes) => {
            calls.push(['hybrid', codes, requestedAt, fallbackLimit, preciseCodes])
            const market = await readers.snapshot(codes, requestedAt)
            return { quotes: market }
        },
        getFubonSnapshotObservations: async codes => {
            calls.push(['fubon', codes]); return { 2330: { price: 120, status: 'success' } }
        },
        getMultipleQuoteObservations: async () => { throw Error('Fugle batch should only supplement missing quotes') },
        getForeignQuotes: async symbols => {
            calls.push(['foreign', symbols]); return { AAPL: 180 }
        },
        isPositivePrice: value => typeof value === 'number' && value > 0,
    })
    const quotes = await mod.getSharedQuoteObservations(['2330', 'US:AAPL'], 'requested', 'global', ['2330'])
    assert.equal(quotes['2330'].price, 120)
    assert.equal(quotes['US:AAPL'].price, 180)
    assert.deepEqual(calls, [['hybrid', ['2330'], 'requested', 10, ['2330']], ['fubon', ['2330']], ['foreign', ['AAPL']]])
})

function providerHarness(hybridEnabled = false, afterClose = false, reader, holdings = ['2330']) {
    const states = [], refs = [], effects = [], requests = [], modes = [], precise = [], writes = [], dividendUpdates = []
    let stateIndex = 0, refIndex = 0, effectIndex = 0, saved = {}, authChanged, priceChanged
    let wait, snapshotWait, dividendWait, snapshotCalls = 0
    const user = { uid: 'A' }, investAuth = { currentUser: user, onAuthStateChanged: fn => { authChanged = fn; fn(investAuth.currentUser); return () => {} } }
    const policy = compile(read('src/lib/pricePolicy.ts'), compile(read('src/lib/date.ts')))
    const mod = compile(read('src/PriceContext.tsx'), {
        require: createRequire(import.meta.url), createContext: () => ({ Provider: 'provider' }),
        useState: initial => { const i = stateIndex++; if (!(i in states)) states[i] = initial; return [states[i], value => { states[i] = typeof value === 'function' ? value(states[i]) : value }] },
        useRef: initial => { const i = refIndex++; return refs[i] ??= { current: initial } },
        useCallback: fn => fn,
        useEffect: (fn, deps) => { const i = effectIndex++; if (!effects[i]) effects[i] = { deps, cleanup: fn() } },
        investAuth, investDB: {}, userDocNested: () => 'prices',
        captureUserSession: () => { const account = investAuth.currentUser; return { doc: () => account.uid, assertActive: () => { if (account !== investAuth.currentUser) throw Error('account changed') } } },
        onSnapshot: (_, fn) => { priceChanged = fn; return () => {} },
        ...policy, ...compile(read('src/lib/priceRefreshPresentation.ts')), createPriceRefreshCoordinator, isFubonSnapshotEnabled: () => hybridEnabled,
        isAfterTaiwanClose: () => afterClose,
        loadHoldingQuoteCodes: async () => holdings,
        loadGlobalQuoteCodes: async () => ['2330', '2317', 'US:AAPL'],
        getSharedQuoteObservations: async (codes, requestedAt, mode, preciseCodes, publish) => {
            requests.push(codes)
            modes.push(mode)
            precise.push(preciseCodes)
            if (reader) return reader(codes, requestedAt, mode, preciseCodes, publish)
            if (wait) await wait.promise
            return Object.fromEntries(codes.map(code => [code, { price: 120, requestedAt, fetchedAt: new Date().toISOString(), sourceDate: '2026-09-18', sourceUpdatedAt: 123, priceType: 'trade', status: 'success' }]))
        },
        runTransaction: async (_, fn) => fn({ get: async () => ({ exists: () => true, data: () => saved }), set: (ref, data) => { writes.push(ref); saved = data } }),
        maybeAutoSnapshotToday: async () => { snapshotCalls++; if (snapshotWait) await snapshotWait.promise; return { status: 'written' } }, console: { error() {} },
        updateDividendAnnouncements: async session => { session.assertActive(); dividendUpdates.push('updated'); if (dividendWait) await dividendWait.promise },
    })
    return {
        dividendUpdates,
        delaySnapshot() { snapshotWait = deferred(); return snapshotWait },
        delayDividends() { dividendWait = deferred(); return dividendWait },
        render() { stateIndex = 0; refIndex = 0; effectIndex = 0; return mod.PriceProvider({ children: null }).props.value },
        requests, modes, precise, writes,
        saved: () => saved, snapshotCalls: () => snapshotCalls,
        delay() { wait = deferred(); return wait },
        switchAccount() { investAuth.currentUser = { uid: 'B' }; authChanged(investAuth.currentUser) },
        remote(data) { priceChanged({ exists: () => true, data: () => data }) },
    }
}

test('actual provider persists a refresh marker and final batch; navigation and repeated refresh reuse quotes', async () => {
    const h = providerHarness(), price = h.render(), snapshots = []
    await Promise.all([price.updatePrices(['2330'], { onSnapshot: v => snapshots.push(v) }), price.updatePrices(['2317'])])
    assert.equal(h.requests.length, 1); assert.equal(h.writes.length, 2)
    assert.equal(snapshots[0].status, 'written')
    // Each route reads the still-mounted provider instead of querying its own prices.
    for (const code of ['2330', '2317', 'US:AAPL']) assert.equal(h.render().prices[code], 120)
    await h.render().updatePrices(['2317'], { onSnapshot: v => snapshots.push(v) })
    await h.render().ensurePrices(['2330'])
    assert.equal(h.requests.length, 1); assert.equal(h.writes.length, 2)
    assert.equal(snapshots.length, 1)
})

test('a new symbol uses direct Fugle pricing when the market snapshot source is enabled', async () => {
    const h = providerHarness(true)
    const result = await h.render().ensurePrices(['2330'])
    assert.equal(result['2330'], 120)
    assert.deepEqual(h.requests, [['2330']])
    assert.deepEqual(h.modes, ['direct'])
})

for (const afterClose of [false, true]) test(`hybrid refresh verifies holdings during ${afterClose ? 'after close' : 'intraday'}`, async () => {
    const h = providerHarness(true, afterClose)
    await h.render().updatePrices(['2330'])
    assert.deepEqual(h.precise, [['2330']])
    assert.deepEqual(h.modes, ['global'])
})

test('switching account during a full refresh cannot write old-account quotes into either account', async () => {
    const h = providerHarness(), wait = h.delay(), pending = h.render().updatePrices(['2330'])
    await tick(); h.switchAccount(); wait.resolve()
    assert.deepEqual(await pending, {})
    assert.equal(h.writes.length, 1) // Captured marker only, before switching accounts.
    assert.equal(h.saved()['2330'], undefined)
    assert.deepEqual(h.render().prices, {})
})

test('quote completion and loading state never wait for dividend or snapshot work; account switch blocks late feedback', async () => {
    const h = providerHarness(), snapshot = h.delaySnapshot(), dividends = h.delayDividends(), callbacks = []
    const result = await h.render().updatePrices(['2330'], { onSnapshot: row => callbacks.push(row) })
    assert.equal(result['2330'], 120)
    assert.equal(h.render().priceLoading, false)
    assert.equal(h.writes.length, 2); assert.equal(h.dividendUpdates.length, 1)
    assert.equal(callbacks.length, 0)
    h.switchAccount(); snapshot.resolve(); dividends.resolve(); await tick()
    assert.deepEqual(callbacks, []); assert.deepEqual(h.render().prices, {})
})

test('background snapshot completion reports after quotes are already visible', async () => {
    const h = providerHarness(), wait = h.delaySnapshot(), callbacks = []
    await h.render().updatePrices(['2330'], { onSnapshot: row => callbacks.push(row) })
    assert.equal(h.render().prices['2330'], 120); assert.equal(callbacks.length, 0)
    wait.resolve(); await tick(); assert.equal(callbacks[0].status, 'written')
})

test('a late foreign batch timeout retains earlier quotes but an entirely failed read still rejects', async () => {
    let requests = 0
    const mod = compile(read('src/lib/foreignQuote.ts'), {
        captureUserSession: () => ({ assertActive() {} }),
        authenticatedFetch: async (_, __, options) => {
            assert.ok(options.signal); requests++
            if (requests > 1) throw Error('timeout')
            return { ok: true, json: async () => ({ AAPL: 120 }) }
        },
    })
    assert.deepEqual(await mod.getForeignQuotes(['AAPL', ...Array.from({ length: 20 }, (_, i) => 'X' + i)]), { AAPL: 120 })
    await assert.rejects(mod.getForeignQuotes(['AAPL']), /timeout/)
})

test('actual provider publishes individual holdings before market completion; partial holdings cannot satisfy snapshot freshness', async () => {
    const market = deferred(), priority = deferred()
    let publishPriority
    const policy = compile(read('src/lib/pricePolicy.ts'), compile(read('src/lib/date.ts')))
    const hybrid = compile(read('src/lib/hybridQuotes.ts'), { ...policy, ...compile(read('src/lib/quoteTiming.ts')) })
    const get = compile(read('src/lib/sharedQuotes.ts'), { ...policy, ...hybrid, isFubonSnapshotEnabled: () => true,
        getFubonSnapshotObservations: () => market.promise,
        getMultipleQuoteObservations: (_codes, _at, _deadline, publish) => { publishPriority = publish; return priority.promise },
        getForeignQuotes: async () => ({}),
    }).getSharedQuoteObservations
    const h = providerHarness(true, false, get, ['2330', '2317'])
    const pending = h.render().updatePrices(['0050'])
    await tick()
    const at = h.saved()._refresh.requestedAt
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(new Date(at))
    const q = price => ({ price, requestedAt: at, fetchedAt: at, sourceDate: today, sourceUpdatedAt: 123, priceType: 'trade', status: 'success' })
    await publishPriority({ 2330: q(120) })
    assert.equal(h.render().prices['2330'], 120)
    assert.deepEqual(policy.stalePriceCodes(['2330', '2317'], h.saved(), today), ['2317'])
    assert.equal(h.snapshotCalls(), 0)
    assert.equal(h.render().priceLoading, true)
    assert.equal(h.render().refreshSummary.holdingsSucceeded, 1)
    assert.equal(h.render().refreshSummary.holdingsElapsedMs, null)
    // Route consumers are replaced while this provider and captured operation live.
    for (const route of ['trend', 'kms', 'dashboard']) {
        assert.equal(h.render().prices['2330'], 120, route)
        assert.match(h.render().refreshProgress, /1\/2/)
    }
    await publishPriority({ 2317: q(80) })
    assert.equal(h.snapshotCalls(), 1)
    assert.match(h.render().refreshProgress, /持股已更新/)
    assert.equal(h.render().refreshSummary.holdingsSucceeded, 2)
    const heldElapsed = h.render().refreshSummary.holdingsElapsedMs
    assert.ok(heldElapsed >= 0)
    assert.match(presentation.priceRefreshStatusText(h.render().refreshSummary), /持股報價已完成.*其他股票背景更新中/)
    priority.resolve({ 2330: q(120), 2317: q(80) })
    market.resolve({ 2330: q(100), 2317: q(70), '0050': q(60) })
    await pending
    assert.equal(h.render().prices['2330'], 120)
    assert.equal(h.render().prices['0050'], 60)
    assert.equal(h.render().priceLoading, false)
    assert.equal(h.render().refreshSummary.phase, 'complete')
    assert.equal(h.render().refreshSummary.holdingsElapsedMs, heldElapsed)
    assert.equal(h.snapshotCalls(), 1)
})

test('an account change after a partial holding publication blocks every later background write', async () => {
    const wait = deferred()
    let publish, at
    const h = providerHarness(true, false, async (_codes, requestedAt, _mode, _held, callback) => {
        publish = callback; at = requestedAt; return wait.promise
    })
    const run = h.render().updatePrices(['2330'])
    await tick()
    const q = { price: 120, requestedAt: at, fetchedAt: at, sourceDate: at.slice(0, 10), sourceUpdatedAt: null, priceType: 'trade', status: 'success' }
    await publish({ 2330: q })
    const writes = h.writes.length
    h.switchAccount()
    await assert.rejects(publish({ 2317: q }), /account changed/)
    wait.resolve({ 2330: q, 2317: q })
    assert.deepEqual(await run, {})
    assert.equal(h.writes.length, writes)
    assert.deepEqual(h.render().prices, {})
    assert.equal(h.render().refreshSummary, null)
})

test('refresh presentation counts only this batch, excludes invalid values and freezes holding completion before background work', () => {
    const at = '2026-10-16T01:00:00.000Z', start = Date.parse(at)
    const quote = (price, requestedAt = at, status = 'success') => ({ price, requestedAt, sourceDate: '2026-10-15', status })
    const saved = {2330: 120, 2317: 110, '0050': 80, _quotes: {2330: quote(120), 2317: quote(110, '2026-10-15T01:00:00Z'), '0050': quote(80)}}
    const partial = presentation.summarizePriceRefresh(saved, ['2330','2317','0050'], ['2330','2317','2330'], at, 'running', start + 1000)
    assert.equal(partial.holdingsTotal, 2)
    assert.equal(partial.holdingsSucceeded, 1)
    assert.equal(partial.holdingsElapsedMs, null)
    assert.match(presentation.holdingQuoteStatus(partial).text, /更新中 1\/2/)
    saved._quotes['2317'] = quote(110)
    const ready = presentation.summarizePriceRefresh(saved, ['2330','2317','0050'], ['2330','2317'], at, 'running', start + 2000, partial, start - 500)
    assert.equal(ready.holdingsElapsedMs, 2500, 'includes the initial code-loading time')
    assert.equal(ready.oldestHoldingDate, '2026-10-15', 'latest returned quotes do not imply today’s closing values')
    assert.match(presentation.holdingQuoteStatus(ready).text, /已完成 · 2.5 秒/)
    const final = presentation.summarizePriceRefresh(saved, ['2330','2317','0050'], ['2330','2317'], at, 'complete', start + 40000, ready)
    assert.equal(final.holdingsElapsedMs, 2500)
    assert.match(presentation.priceRefreshStatusText(final), /全部報價已更新/)
    for (const price of [null, NaN, Infinity, -1, 0, 999]) {
        saved['2317'] = price
        const bad = presentation.summarizePriceRefresh(saved, ['2330','2317'], ['2330','2317'], at, 'complete')
        assert.equal(bad.holdingsSucceeded, 1)
        assert.equal(presentation.holdingQuoteStatus(bad).tone, 'warning')
        assert.match(presentation.priceRefreshStatusText(bad), /1 檔未取得有效報價/)
    }
})

test('refresh presentation distinguishes no holdings, failures and a fresh request from a previous completion', () => {
    const at = '2026-10-16T01:00:00Z'
    const empty = presentation.summarizePriceRefresh({}, ['0050'], [], at, 'running')
    assert.equal(presentation.holdingQuoteStatus(empty).text, '目前沒有持股')
    assert.equal(empty.holdingsElapsedMs, null)
    assert.equal(presentation.holdingQuoteStatus({...empty,phase:'error'}).text, '持股報價狀態未確認')
    const failed = presentation.summarizePriceRefresh({2330:120,_quotes:{2330:{requestedAt:at,price:120,status:'failed'}}}, ['2330'], ['2330'], at, 'error')
    assert.equal(failed.received, 1)
    assert.equal(failed.holdingsSucceeded, 0)
    assert.match(presentation.holdingQuoteStatus(failed).text, /未齊 0\/1/)
    const next = presentation.summarizePriceRefresh({}, ['2330'], ['2330'], '2026-10-16T01:01:00Z', 'preparing', Date.now(), {...failed,holdingsElapsedMs:1000})
    assert.equal(next.holdingsElapsedMs, null)
    assert.match(presentation.holdingQuoteStatus(next).text, /準備中/)
    assert.equal(presentation.holdingQuoteStatus(null), null)
})

test('a wave of twenty holding results is coalesced instead of serializing twenty transactions', async () => {
    const holdings = Array.from({ length: 20 }, (_, i) => String(1000 + i))
    const h = providerHarness(true, false, async (codes, at, _mode, _held, publish) => {
        const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(new Date(at))
        const quotes = Object.fromEntries(codes.map(code => [code, { price: 120, requestedAt: at, fetchedAt: at,
            sourceDate: today, sourceUpdatedAt: null, priceType: 'trade', status: 'success' }]))
        await Promise.all(Object.entries(quotes).map(([code, quote]) => publish({ [code]: quote })))
        return quotes
    }, holdings)
    await h.render().updatePrices(holdings)
    assert.equal(h.writes.length, 3) // marker, coalesced publication, final merge
    assert.equal(h.snapshotCalls(), 1)
    assert.ok(holdings.every(code => h.render().prices[code] === 120))
})
