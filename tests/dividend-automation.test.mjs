import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { compile, read } from './helpers/compile.mjs'
import { memoryFirestore } from './helpers/memory-firestore.mjs'
import { DIVIDEND_SOURCES, parseDividendAnnouncements, publicDividendCatalog, refreshDividendAnnouncements } from '../netlify/lib/dividend-announcements.js'
import { reserveQuoteBudget } from '../netlify/lib/quote-budget.js'

const now = new Date('2026-10-01T02:00:00Z')

test('quote budget stamps the actual transaction attempt after delayed reads and retries', async () => {
    let clock=0, committed
    const mod=compile(read('netlify/lib/quote-budget.js'),{Date:{now:()=>clock}})
    const db={doc:()=>({}),runTransaction:async callback=>{
        for(let attempt=0;attempt<2;attempt++) {
            await callback({get:async()=>{clock+=15000;return {data:()=>({})}},set:(_ref,data)=>{committed=data}})
        }
        return {granted:1}
    }}
    await mod.reserveQuoteBudget(db,1)
    assert.deepEqual(committed.starts,[30000])
})
const fixtures = Object.fromEntries(['TWSE', 'TPEX'].map(market => [market, JSON.parse(readFileSync(new URL(`./fixtures/dividend-data/${market}-2026-10-01.json`, import.meta.url), 'utf8'))]))
const publicFetch = async url => ({ ok: true, json: async () => structuredClone(fixtures[url === DIVIDEND_SOURCES.TWSE ? 'TWSE' : 'TPEX']) })
const announcement = (patch = {}) => {
    const row = { market: 'TWSE', date: '2026-10-05', code: '2330', name: 'fixture', cashPerShare: 2, stockRatio: 0.01,
        checkedAt: now.toISOString(), active: true, source: DIVIDEND_SOURCES.TWSE, ...patch }
    return { ...row, id: `${row.market}-${row.code}-${row.date}` }
}
const calc = compile(read('src/lib/calc.ts'))
const validation = compile(read('src/lib/investmentValidation.ts'), calc)
const integrity = compile(read('src/lib/ledgerIntegrity.ts'), calc)
const trade = (patch = {}) => {
    const row = { id: 'buy', date: '2026-10-02', type: 'buy', code: '2330', name: 'fixture', shares: 1000, price: 100, fee: 0, tax: 0, ...patch }
    return { ...row, total: calc.calcTradeTotal(row) }
}
function adminStore(seed = {}) {
    const h = memoryFirestore(seed)
    const db = {
        doc: path => ({ path, get: async () => ({ data: () => structuredClone(h.store.get(path)) }) }),
        runTransaction: fn => h.bindings.runTransaction('admin', tx => fn({
            get: ref => tx.get(ref.path),
            set: (ref, data, options) => tx.set(ref.path, options?.merge ? { ...h.store.get(ref.path), ...data } : data),
        })),
    }
    return { ...h, db, value: () => h.store.get('sharedData/dividendAnnouncements') }
}
function clientHarness(data = { entries: [announcement()], marketCheckedAt: { TWSE: now.toISOString() } }, saved = null) {
    const storage = new Map(saved ? [['symbiosis.dividend.announcements', saved]] : [])
    let calls = 0, gate, fail = false, active = true
    class Clock extends Date { static now() { return +now + 2000 } }
    const session = { assertActive() { if (!active) throw Error('account changed') } }
    const mod = compile(read('src/lib/dividendAnnouncements.ts'), {
        ...calc, ...validation, publicDividendCatalog, Date: Clock,
        localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) },
        captureUserSession: () => session,
        authenticatedFetch: async () => { calls++; if (gate) await gate; if (fail) throw Error('offline'); return { json: async () => data } },
    })
    return { ...mod, storage, session, calls: () => calls, delay: promise => { gate = promise }, fail: () => { fail = true }, switchAccount: () => { active = false } }
}

test('real public exchange fixtures parse ROC dates, pending ETF cash, and free shares without capital subscriptions', () => {
    const tw = parseDividendAnnouncements('TWSE', fixtures.TWSE, now), otc = parseDividendAnnouncements('TPEX', fixtures.TPEX, now)
    assert.equal(tw.length, 35); assert.equal(otc.length, 37)
    assert.ok(tw.some(row => row.cashPerShare === null && row.code.startsWith('00')))
    const freeShares = tw.find(row => row.code === '2614')
    assert.equal(freeShares.stockRatio, 0.08); assert.equal(freeShares.cashPerShare, 0.4)
    assert.ok(otc.some(row => row.code === '00697B' && row.date === '2026-09-21' && row.cashPerShare === 0.31))
    assert.ok([...tw, ...otc].every(row => !Object.hasOwn(row, 'cashPaymentDate') && !Object.hasOwn(row, 'stockDistributionDate')))
})

test('malformed dates, unknown money, conflicting rows and private fields cannot become an official catalogue', () => {
    const bad = structuredClone(fixtures.TWSE)
    bad.data[0][bad.fields.indexOf('除權除息日期')] = '115年02月30日'
    assert.throws(() => parseDividendAnnouncements('TWSE', bad, now), /date/)
    const money = structuredClone(fixtures.TPEX); money[0].CashDividend = 'secret invalid amount'
    assert.throws(() => parseDividendAnnouncements('TPEX', money, now), /amount/)
    const duplicate = [...fixtures.TPEX, { ...fixtures.TPEX[0], CashDividend: '999' }]
    assert.throws(() => parseDividendAnnouncements('TPEX', duplicate, now), /Conflicting/)
    const clean = publicDividendCatalog({ entries: [{ ...announcement(), uid: 'private', shares: 999 }], marketCheckedAt: { TWSE: now.toISOString() }, token: 'private' })
    assert.ok(!JSON.stringify(clean).includes('private')); assert.ok(!Object.hasOwn(clean.entries[0], 'shares'))
})

test('simultaneous server instances share one daily upstream attempt; failed sources retain past forecasts and warnings', async () => {
    const h = adminStore(); let requests = 0
    const fetcher = async url => { requests++; return publicFetch(url) }
    await Promise.all([refreshDividendAnnouncements(h.db, fetcher, now), refreshDividendAnnouncements(h.db, fetcher, now)])
    assert.equal(requests, 2)
    const before = structuredClone(publicDividendCatalog(h.value()))
    await refreshDividendAnnouncements(h.db, fetcher, new Date(+now + 23 * 3600000)); assert.equal(requests, 2)
    const later = new Date(+now + 86400000)
    const failed = await refreshDividendAnnouncements(h.db, async () => { throw Error('offline') }, later)
    assert.deepEqual(failed.failures, ['TWSE', 'TPEX']); assert.deepEqual(publicDividendCatalog(h.value()), before)
    const cachedFailure = await refreshDividendAnnouncements(h.db, fetcher, new Date(+later + 1000))
    assert.deepEqual(cachedFailure.failures, ['TWSE', 'TPEX']); assert.equal(requests, 2)
})

test('market failure preserves its entries; disappeared future announcements become inactive while past rights remain', async () => {
    const past = announcement({ date: '2026-09-30' }), future = announcement(), otc = announcement({ market: 'TPEX', code: '6488', source: DIVIDEND_SOURCES.TPEX })
    const h = adminStore({ 'sharedData/dividendAnnouncements': { entries: [past, future, otc], marketCheckedAt: {} } })
    await refreshDividendAnnouncements(h.db, async url => {
        if (url === DIVIDEND_SOURCES.TPEX) throw Error('offline')
        return { ok: true, json: async () => ({ ...fixtures.TWSE, data: [] }) }
    }, now)
    const rows = h.value().entries
    assert.equal(rows.find(row => row.id === past.id).active, true)
    assert.equal(rows.find(row => row.id === future.id).active, false)
    assert.equal(rows.find(row => row.id === otc.id).active, true)
    assert.deepEqual(h.value().lastFailures, ['TPEX'])
})

test('forecast qualifies pre-ex-date holdings even after sale, excludes ex-day buys and future planned trades', () => {
    const h = clientHarness(), catalog = { entries: [announcement()], marketCheckedAt: {} }
    const trades = [trade(), trade({ id: 'sold', type: 'sell', date: '2026-10-06' })]
    const original = structuredClone(trades)
    const past = h.buildDividendForecasts(catalog, trades, [], '2026-10-08')[0]
    assert.equal(past.shares, 1000); assert.equal(past.cashGross, 2000); assert.equal(past.stockShares, 10)
    assert.deepEqual(trades, original); assert.equal(calc.calcPositions(trades, [], { asOf: '2026-10-08' }).holdings['2330'].shares, 0)
    assert.deepEqual(h.buildDividendForecasts(catalog, [trade({ date: '2026-10-05' })], [], '2026-10-08'), [])
    assert.deepEqual(h.buildDividendForecasts(catalog, [trade({ date: '2026-10-04' })], [], '2026-10-01'), [])
    assert.equal(h.buildDividendForecasts(catalog, [trade({ date: '2026-09-30', shares: 29 })], [], '2026-10-01')[0].shares, 29)
    assert.deepEqual(h.buildDividendForecasts(catalog, trades, [{ date: '2026-10-05', code: '2330.TW', cashDividend: 1900, stockDividend: 10 }], '2026-10-08'), [])
})

test('unknown cash, foreign currency, margin lots and eight-decimal stock precision are explicitly preserved', () => {
    const h = clientHarness()
    const rows = h.buildDividendForecasts({ entries: [announcement({ cashPerShare: null, stockRatio: 0.00999999 })], marketCheckedAt: {} }, [trade({ isMargin: true, marginAmount: 60000, marginRatio: 0.6 })], [], '2026-10-05')
    assert.equal(rows[0].cashGross, null); assert.equal(rows[0].hasMargin, true); assert.equal(rows[0].stockShares, 10)
    const foreign = h.buildDividendForecasts({ entries: [announcement({ code: '00865C' })], marketCheckedAt: {} }, [trade({ code: '00865C' })], [], '2026-10-05')
    assert.equal(foreign[0].foreignCurrency, true)
})

test('public client coalesces clicks, caches no entitlement or account data, and retains partial-failure warnings after reload', async () => {
    const data = { entries: [announcement()], marketCheckedAt: { TWSE: now.toISOString() }, refreshFailures: ['TPEX'] }
    const h = clientHarness(data)
    await Promise.all([h.updateDividendAnnouncements(h.session, +now), h.updateDividendAnnouncements(h.session, +now)])
    await h.updateDividendAnnouncements(h.session, +now + 30000); assert.equal(h.calls(), 1)
    const saved = h.storage.get('symbiosis.dividend.announcements')
    assert.ok(!saved.includes('uid')); assert.ok(!saved.includes('token')); assert.ok(!saved.includes('shares'))
    assert.match(clientHarness(data, saved).getDividendFeedState().error, /部分/)
    h.fail(); await h.updateDividendAnnouncements(h.session, +now + 86400000)
    assert.equal(h.getDividendFeedState().catalog.entries[0].id, announcement().id)
    assert.match(h.getDividendFeedState().error, /offline/)
})

test('receipt confirmation needs actual payment dates; duplicate automatic/manual confirmations and retries are safe', async () => {
    const row = { date: '2026-10-05', code: '2330', name: 'fixture', status: 'confirmed', sourceAnnouncementId: announcement().id,
        cashDividend: 1900, stockDividend: 10, cashPaymentDate: '2026-10-20', stockDistributionDate: '2026-10-25' }
    assert.equal(validation.validateDividendForWrite({ ...row, cashPaymentDate: '' }).valid, false)
    assert.equal(validation.validateDividendForWrite({ ...row, sourceAnnouncementId: 'TWSE-2317-2026-10-05' }).valid, false)
    for (const order of [false, true]) {
        const h = memoryFirestore({ 'users/a/trades/buy': trade() })
        const mod = compile(read('src/lib/ledgerWrites.ts'), { ...calc, ...validation, ...integrity, ...h.bindings })
        const auto = { collection: 'dividends', id: 'auto-div-' + announcement().id, data: row, mode: 'create' }
        const manual = { collection: 'dividends', id: 'manual', data: { ...row, sourceAnnouncementId: undefined }, mode: 'create' }
        delete manual.data.sourceAnnouncementId
        const result = await Promise.allSettled((order ? [manual, auto] : [auto, manual]).map(write => mod.commitLedgerWrites([write])))
        assert.equal(result.filter(r => r.status === 'fulfilled').length, 1)
        assert.equal([...h.store.keys()].filter(path => path.includes('/dividends/')).length, 1)
        const winner = result[order ? 1 : 0].status === 'fulfilled' ? auto : manual
        await mod.commitLedgerWrites([winner]); assert.equal([...h.store.keys()].filter(path => path.includes('/dividends/')).length, 1)
    }
})

test('public dividend endpoint requires identity and never returns private catalogue fields', async () => {
    const denied = compile(read('netlify/functions/dividend-announcements.js'), {
        authorizeApiIdentity: async () => ({ statusCode: 401 }),
        cachedApi: () => assert.fail('No cache/upstream on unauthorized request'),
    })
    assert.equal((await denied.handleEvent({ httpMethod: 'GET' })).statusCode, 401)
    const h = adminStore({ 'sharedData/dividendAnnouncements': { entries: [announcement()], marketCheckedAt: {}, uid: 'private-canary' } })
    const mod = compile(read('netlify/functions/dividend-announcements.js'), {
        authorizeApiIdentity: async () => ({ db: h.db, uid: 'private-canary' }), cachedApi: (_, __, loader) => loader(),
        refreshDividendAnnouncements: async () => ({ failures: [] }), publicDividendCatalog, apiHeaders: {},
    })
    const response = await mod.handleEvent({ httpMethod: 'GET' })
    assert.equal(response.statusCode, 200); assert.ok(!response.body.includes('private-canary'))
})

test('quote leases cap simultaneous devices/instances together; retries consume quota and expiry is conservative', async () => {
    const h = adminStore()
    const grants = await Promise.all([reserveQuoteBudget(h.db, 40, +now), reserveQuoteBudget(h.db, 40, +now)])
    assert.equal(grants.reduce((sum, result) => sum + result.granted, 0), 55)
    assert.equal((await reserveQuoteBudget(h.db, 1, +now + 61000)).granted, 0)
    assert.equal((await reserveQuoteBudget(h.db, 55, +now + 70000)).granted, 55)
    const corrupt = adminStore({ 'sharedData/fugleQuoteBudget': { starts: ['invalid'] } })
    await assert.rejects(reserveQuoteBudget(corrupt.db, 1, +now), /Invalid/)
})

test('deduplicated client batches consume exactly 20 server leases and leave the other 35 available', async () => {
    const h = adminStore(), reservations = [], sent = []
    const policy = compile(read('src/lib/pricePolicy.ts'))
    const mod = compile(read('src/lib/fugle.ts').replace('import.meta.env.VITE_FUGLE_API_KEY', "'fixture-not-a-real-key'"), {
        ...compile(read('src/lib/quoteTiming.ts')),
        ...policy, captureUserSession: () => ({ assertActive() {} }),
        authenticatedFetch: async (_, __, init) => {
            const input=JSON.parse(init.body)
            reservations.push(1)
            const budget=await reserveQuoteBudget(h.db,1,+now)
            if (!budget.granted) return {ok:false,status:429,headers:{get:()=>String(budget.retryAfter)}}
            sent.push(input.symbol)
            return {ok:true,status:200,json:async()=>({closePrice:120,date:'2026-10-01'})}
        },
    })
    const codes = Array.from({ length: 55 }, (_, i) => String(1000 + i))
    await Promise.all([
        mod.getMultipleQuoteObservations(codes.slice(0, 20), now.toISOString()),
        mod.getMultipleQuoteObservations(codes.slice(0, 20), now.toISOString()),
    ])
    assert.equal(reservations.length,20); assert.equal(sent.length, 20)
    assert.equal(h.store.get('sharedData/fugleQuoteBudget').starts.length, 20)
    const remaining = await mod.getMultipleQuoteObservations(codes.slice(20), now.toISOString())
    assert.ok(Object.values(remaining).every(row => row.status === 'success'))
    assert.equal(reservations.length,55); assert.equal(sent.length, 55)
    assert.equal(h.store.get('sharedData/fugleQuoteBudget').starts.length, 55)
    const denied = await mod.getMultipleQuoteObservations(['2330'], now.toISOString())
    assert.equal(denied['2330'].status, 'failed'); assert.equal(sent.length, 55)
})
