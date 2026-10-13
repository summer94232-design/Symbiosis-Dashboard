import test from 'node:test'
import assert from 'node:assert/strict'
import ts from 'typescript'
import { compile, read } from './helpers/compile.mjs'
import { memoryFirestore } from './helpers/memory-firestore.mjs'
const calc = compile(read('src/lib/calc.ts'))
const performance = compile(read('src/lib/performanceReturns.ts'))
const dates = compile(read('src/lib/date.ts'))
const policy = compile(read('src/lib/pricePolicy.ts'), dates)
const portfolio = compile(read('src/lib/portfolioSnapshot.ts'), { ...calc, ...dates, ...policy })
const validation = compile(read('src/lib/investmentValidation.ts'), calc)
function callback(path, name, bindings) {
    const source = read(path), ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
    let initializer
    function visit(node) {
        if (ts.isVariableDeclaration(node) && node.name.getText(ast) === name) initializer = node.initializer
        ts.forEachChild(node, visit)
    }
    visit(ast)
    assert.ok(initializer, name)
    const fn = ts.isCallExpression(initializer) ? initializer.arguments[0] : initializer
    return compile('export const run = ' + fn.getText(ast), bindings).run
}
const near = (value, expected) => assert.ok(Math.abs(value - expected) < 1e-7, `${value} != ${expected}`)
const close = (date, totalAssets) => ({ date, totalAssets, valuationQuality: 'closing' })
const buy = { id: 'buy', date: '2026-01-05', code: '2330', name: '隔離', type: 'buy', shares: 1000, price: 100, fee: 0, tax: 0, total: 40000, isMargin: true, marginAmount: 60000, marginRatio: 0.6 }
const div = { id: 'div', date: '2026-02-01', stockDistributionDate: '2026-03-02', code: '2330', name: '隔離', status: 'confirmed', cashDividend: 0, stockDividend: 100 }
const sell = { ...buy, id: 'sell', type: 'sell', date: '2026-03-03', shares: 1100, total: 50000, marginRepay: 60000, marginPrincipal: 60000, marginInterest: 0 }

test('R01 dividend reports use confirmed actual payment dates, exclude announcements and future payments', () => {
    const rows = [{ ...div, cashDividend: 100, cashPaymentDate: '2027-01-04' }, { ...div, status: 'announced', cashDividend: 200 }, { ...div, cashDividend: 300, cashPaymentDate: '2026-09-01' }]
    assert.deepEqual(calc.receivedCashDividends(rows, '2026-10-04').map(d => [d.date, d.cashDividend]), [['2026-09-01', 300]])
    assert.equal(rows[2].date, '2026-02-01', 'source ex-date remains intact')
})
test('R02 shared XIRR resolves extreme gains and losses on a 365-day basis; impossible roots remain null', () => {
    for (const end of [0.1, 80, 120, 20000]) near(performance.accountXirr([{ date: '2025-01-01', amount: -100 }, { date: '2026-01-01', amount: end }]), end / 100 - 1)
    assert.equal(performance.accountXirr([{ date: '2025-01-01', amount: 100 }, { date: '2026-01-01', amount: 120 }]), null)
})
test('R03 historical estimated return uses dated NAV endpoints, including legacy snapshots', () => {
    const input = { snapshots: [close('2025-01-01', 100000), close('2026-01-01', 120000)], startDate: '2025-01-01', endDate: '2026-01-01', cashflows: [] }
    near(performance.calculateSnapshotAccountReturn(input).annualized, 20)
    assert.match(performance.calculateSnapshotAccountReturn({ ...input, snapshots: input.snapshots.slice(0, 1) }).reason, /缺少/)
    near(performance.calculateSnapshotAccountReturn({ ...input, snapshots: input.snapshots.map(s => ({ ...s, valuationQuality: undefined })) }).annualized,20)
    assert.equal(performance.calculateSnapshotAccountReturn({...input,snapshots:[...input.snapshots,input.snapshots[1]]}).annualized,null)
})
test('R04 maximum drawdown uses a flow-adjusted NAV index, handles all-loss periods and excludes deposits', () => {
    const curve = values => performance.buildTimeWeightedReturns(values.map((v, i) => close(`2026-01-0${i + 1}`, v)), [], true, true)
    near(performance.calculateReturnDrawdown(curve([100000, 101000, 100500])), 500 / 101000)
    near(performance.calculateReturnDrawdown(curve([100000, 99000, 98000])), 0.02)
    const points = performance.buildTimeWeightedReturns([close('2026-01-01', 100000), close('2026-01-02', 200000)], [{ date: '2026-01-02', amount: 100000 }], true, true)
    assert.equal(performance.calculateReturnDrawdown(points), 0)
    assert.equal(performance.calculateReturnDrawdown([{ date: '2026-01-01', assetReturn: null, issue: 'missing' }]), null)
})
test('R05 KMS stops between batches and before legacy fallback on account change, with no B body read', async () => {
    const h = memoryFirestore({ 'users/a/noteBodies/same': { content: 'A' }, 'users/b/noteBodies/same': { content: 'B' } })
    const reads = []
    const mod = compile(read('src/lib/kmsData.ts'), { ...h.bindings, getDoc: async path => { reads.push(path); return { exists: () => h.store.has(path), data: () => h.store.get(path) } } })
    await assert.rejects(mod.fetchKmsBodiesInBatches(['same', 'same'], 1, () => { h.state.uid = 'b' }), /變更/)
    assert.deepEqual(reads, ['users/a/noteBodies/same'])
    h.state.uid = 'a'
    const fallback = compile(read('src/lib/kmsData.ts'), { ...h.bindings, getDoc: async path => { reads.push(path); h.state.uid = 'b'; return { exists: () => false } } })
    await assert.rejects(fallback.fetchKmsNoteBody('legacy'), /變更/)
    assert.equal(reads.at(-1), 'users/a/noteBodies/legacy')
    assert.ok(reads.every(path => !path.startsWith('users/b/')))
})
test('R06 confirmed margin bonus shares use one inventory/debt/repayment timeline and fully close correctly', () => {
    const dividends = [{ ...div, stockDividendMarginShares: 100 }]
    assert.equal(calc.calcSharesBeforeTrade(sell, [buy], dividends), 1100)
    const estimate = calc.estimateMarginRepayment(sell, [buy], dividends)
    assert.equal(estimate.unmatchedShares, 0); assert.equal(estimate.principal, 60000)
    assert.equal(calc.aggregateMarginPositions([buy], undefined, dividends)[0].shares, 1100)
    const result = calc.calcPositions([buy, sell], dividends)
    assert.equal(result.holdings['2330'].shares, 0); assert.equal(result.holdings['2330'].marginAmount, 0)
    assert.equal(result.realized[0].realized, 10000)
    assert.equal(calc.aggregateMarginDebt([buy, sell], undefined, dividends), 0)
    const namedBuy = {...buy,brokerAccount:'Yuanta'}, namedSell = {...sell,brokerAccount:'Yuanta'}
    assert.equal(calc.calcSharesBeforeTrade(namedSell, [namedBuy], dividends), 1100)
    assert.equal(calc.calcPositions([namedBuy,namedSell], dividends).holdings['2330'].shares, 0)
})
test('R06 unspecified classification cannot authorize a margin sale; confirmed cash distribution preserves margin debt', () => {
    assert.equal(calc.calcSharesBeforeTrade(sell, [buy], [div]), 1000)
    assert.throws(() => calc.calcPositions([buy, sell], [div]), /配股.*融資股數/)
    const cashDiv = { ...div, stockDividendMarginShares: 0 }
    const cashSale = { ...sell, isMargin: false, shares: 100, total: 10000 }
    assert.equal(calc.calcSharesBeforeTrade(cashSale, [buy], [cashDiv]), 100)
    const result = portfolio.buildPortfolioSnapshot({ asOf: '2026-03-03', trades: [buy, cashSale], dividends: [cashDiv], cashflow: [], savedPrices: {2330:100} })
    assert.equal(result.marginDebt, 60000); assert.equal(result.marginPositions[0].shares, 1000)
    assert.equal(result.marginPositions[0].marginCost, 90909)
    assert.equal(validation.validateDividendForWrite({ ...div, stockDividendMarginShares: 101 }).valid, false)
})
test('R07 intraday, manual and legacy snapshots supply estimated daily trends without relabeling their quality', async () => {
    for (const valuationQuality of [undefined, 'intraday', 'manual-unverified']) {
        const points = performance.buildTimeWeightedReturns([close('2026-01-01', 100), { date: '2026-01-02', totalAssets: 120, valuationQuality }], [], true, true)
        assert.equal(points[1].assetReturn,20); assert.equal(performance.calculateReturnDrawdown(points),0)
    }
    const h = memoryFirestore({ 'users/a/assetSnapshots/2026-01-02': close('2026-01-02', 100) })
    const mod = compile(read('src/lib/snapshot.ts'), h.bindings)
    assert.equal(await mod.saveValuationSnapshot({ date: '2026-01-02', totalAssets: 120, valuationQuality: 'intraday' }),true)
    assert.equal(h.store.get('users/a/assetSnapshots/2026-01-02').totalAssets,120)
    assert.equal(h.store.get('users/a/assetSnapshots/2026-01-02').valuationQuality,'intraday')
    h.store.set('users/a/assetSnapshots/2026-01-02', { date: '2026-01-02', totalAssets: 95 })
    assert.equal(await mod.saveValuationSnapshot(close('2026-01-02', 100), h.captureUserSession(), false),false)
    assert.equal(h.store.get('users/a/assetSnapshots/2026-01-02').totalAssets,95)
})
test('R07 snapshot quality needs an actual source closing signal, not a valid intraday trade', async () => {
    const day='2026-03-03', h=memoryFirestore()
    let isFinalClose=false
    const mod=compile(read('src/lib/snapshot.ts'), {
        ...h.bindings, ...portfolio, toLocalDateString:()=>day,
        fetchTrades:async()=>[buy], fetchDividends:async()=>[], fetchCashflow:async()=>[],
        getDocFromServer:async()=>({exists:()=>true,data:()=>({2330:100,_quotes:{2330:{price:100,requestedAt:day+'T06:00:00Z',fetchedAt:day+'T06:00:00Z',sourceDate:day,sourceUpdatedAt:123,status:'success',priceType:'trade',isFinalClose}}})}),
    })
    assert.equal((await mod.buildTodaySnapshot()).snapshot.valuationQuality,'intraday')
    isFinalClose=true
    assert.equal((await mod.buildTodaySnapshot()).snapshot.valuationQuality,'closing')
})
test('R05 export rejects previously loaded A summaries when the active account is B before export starts', async () => {
    const h=memoryFirestore(), loaded=h.captureUserSession()
    h.state.uid='b'
    let reads=0, message=''
    const run=callback('src/pages/kms/KMSExport.tsx','handleExport',{
        exportingLock:{current:false},loadedSession:{current:loaded},
        setExporting(){},setExportProgress(){},setNotes(){},setAllTags(){},setHasLoaded(){},setLoadError(){},
        fetchKmsBodiesInBatches:async()=>{reads++;throw Error('must not read B')},
        alertAction:async value=>{message=value},console:{error(){}},
    })
    await run(); assert.equal(reads,0); assert.match(message,/變更/)
})
test('R08 actual advanced annual loader shows dividend-only years and actual payment year', async () => {
    let stats, heat
    const setters = Object.fromEntries(['XirrLoading', 'RangeStart', 'RangeEnd', 'RealizedTrades', 'TotalWins', 'TotalTrades', 'WinRate', 'AvgHoldingDays', 'Mdd', 'Xirr', 'PerformanceMessage', 'HasLoaded', 'RangeStats'].map(name => ['set'+name, () => {}]))
    const run = callback('src/pages/invest/YearReview.tsx', 'loadPerformance', {
        ...calc, ...performance, ...setters, captureUserSession: () => ({ assertActive() {} }), toLocalDateString: () => '2026-10-04',
        fetchTrades: async () => [], fetchDividends: async () => [{ ...div, date: '2025-12-01', cashPaymentDate: '2026-01-05', cashDividend: 300, stockDividend: 0 }],
        fetchCashflow: async () => [], fetchAssetSnapshots: async () => [close('2025-10-04',100000),close('2026-10-04',120000)],
        performanceSnapshotsRef: { current: [] }, performanceCashflowsRef: { current: [] },
        setYearStats: rows => { stats = rows }, setHeatmapData: value => { heat = value }, console: { error: error => { throw error } },
    })
    await run(); assert.equal(stats.length, 1); assert.equal(stats[0].year, 2026); assert.equal(stats[0].dividend, 300)
    assert.equal(stats[0].tradeCount, 0); assert.equal(stats[0].winRate, null); assert.deepEqual(heat, {'2026-01':300})
    near(stats[0].totalReturnRate,20); assert.equal(stats[0].returnRate,null, 'closed-trade rate is separate from account return')
})
test('Fugle proxy checks authorization, fixed routes, global budget, secret-free errors and response fields', async () => {
    let authorized = true, grant = 1, calls = 0
    const key = 'fixture-secret-canary'
    const mod = compile(read('netlify/functions/fugle-proxy.js'), {
        process: { env: {FUGLE_API_KEY:key} }, authorizeApiIdentity: async () => authorized ? { db: 'fixture' } : { statusCode: 401 },
        apiError: (statusCode,error,headers={}) => ({statusCode,body:JSON.stringify({error}),headers}), apiHeaders: {},
        reserveQuoteBudget: async () => ({ granted: grant, retryAfter: 70 }),
        fetch: async (url, options) => { calls++; assert.equal(url.origin, 'https://api.fugle.tw'); assert.equal(options.headers['X-API-KEY'],key); return Response.json({ date:'2026-10-02', closePrice:100, isClose:true, secret:key }) },
    })
    const event = input => ({httpMethod:'POST',body:JSON.stringify(input)})
    const input = {kind:'quote',symbol:'2330'}
    authorized = false; assert.equal((await mod.handleEvent(event(input))).statusCode,401); assert.equal(calls,0)
    authorized = true; assert.equal((await mod.handleEvent(event({...input,symbol:'../secret'}))).statusCode,400)
    assert.equal((await mod.handleEvent(event({kind:'history',symbol:'2330',from:'2026-02-30',to:'2026-03-01'}))).statusCode,400)
    grant=0; const denied=await mod.handleEvent(event(input)); assert.equal(denied.statusCode,429); assert.equal(calls,0)
    grant=1; const ok=await mod.handleEvent(event(input)); assert.equal(ok.statusCode,200); assert.ok(!ok.body.includes(key)); assert.equal(calls,1)
})
test('SheetJS patched release retains XLSX reader/writer compatibility for brokerage tables', async () => {
    const XLSX = await import('xlsx')
    assert.equal(XLSX.version, '0.20.3')
    const rows = [{ 日期:'2026-10-02', 代號:'2330', 股數:1000 }]
    const book=XLSX.utils.book_new(); XLSX.utils.book_append_sheet(book,XLSX.utils.json_to_sheet(rows),'交易')
    const result=XLSX.read(XLSX.write(book,{bookType:'xlsx',type:'buffer'}),{type:'buffer'})
    assert.deepEqual(XLSX.utils.sheet_to_json(result.Sheets['交易']), rows)
})

test('R06 recheck: credit bonus shares retain FIFO acquisition lots for partial sales and repayment', () => {
    const second = { ...buy, id: 'second', date: '2026-01-06', price: 200, marginAmount: 120000, total: 80000 }
    const dividends = [{ ...div, stockDividend: 200, stockDividendMarginShares: 200 }]
    for (const [shares, expectedCost, expectedPrincipal] of [[550, 50000, 30000], [1100, 100000, 60000], [1650, 200000, 120000]]) {
        const sale = { ...sell, shares, marginPrincipal: expectedPrincipal, marginRepay: expectedPrincipal }
        const estimate = calc.estimateMarginRepayment(sale, [buy, second], dividends)
        const result = calc.calcPositions([buy, second, sale], dividends, { includeInventoryLots: true })
        near(result.realized[0].avgCost * shares, expectedCost)
        assert.equal(estimate.principal, expectedPrincipal)
        near(result.holdings['2330'].totalCost, 300000 - expectedCost)
        assert.equal(result.holdings['2330'].marginAmount, 180000 - expectedPrincipal)
        assert.equal(result.inventoryLots['2330'].filter(lot => lot.shares > 0).at(-1).buyId, 'second')
    }
})

test('R06 recheck: the ledger writer can repair a legacy classification even when later sales exist', async () => {
    const otherBuy = { id: 'other-buy', date: '2026-01-06', code: '2317', name: '隔離', type: 'buy', shares: 1000, price: 100, fee: 0, tax: 0, total: 100000 }
    const otherSell = { ...otherBuy, id: 'other-sell', type: 'sell', date: '2026-03-04', shares: 100, total: 10000 }
    const rows = [buy, sell, otherBuy, otherSell]
    const h = memoryFirestore(Object.fromEntries([
        ...rows.map(row => [`users/a/trades/${row.id}`, row]), ['users/a/dividends/div', div],
    ]))
    const integrity = compile(read('src/lib/ledgerIntegrity.ts'), calc)
    const writer = compile(read('src/lib/ledgerWrites.ts'), { ...h.bindings, ...calc, ...validation, ...integrity })
    assert.throws(() => calc.calcPositions(rows, [div]), /配股.*融資股數/)
    await writer.commitLedgerWrites([{ collection: 'dividends', id: 'div', mode: 'update', data: { ...div, stockDividendMarginShares: 100 } }])
    const confirmed = h.store.get('users/a/dividends/div')
    assert.equal(calc.calcPositions(rows, [confirmed]).holdings['2330'].shares, 0)
    assert.equal(calc.calcPositions(rows, [confirmed]).holdings['2317'].shares, 900)
    await assert.rejects(writer.commitLedgerWrites([{ collection: 'dividends', id: 'div', mode: 'update', data: { ...confirmed, stockDividendMarginShares: 50 } }]), /缺少 50 股/)
    assert.equal(h.store.get('users/a/dividends/div').stockDividendMarginShares, 100)
})

test('R04 recheck: a valid total-loss interval still reports a 100% drawdown', () => {
    let stats
    const run = callback('src/pages/invest/YearReview.tsx', 'calcRangeStats', {
        ...performance, rangeStart: '2025-01-01', rangeEnd: '2026-01-01', realizedTrades: [],
        performanceSnapshotsRef: { current: [close('2025-01-01', 100000), close('2026-01-01', 0)] },
        performanceCashflowsRef: { current: [] }, setRangeLoading() {}, setRangeMessage() {}, setRangeStats: value => { stats = value },
    })
    run()
    assert.equal(stats.xirr, -1)
    assert.equal(stats.mdd, 1)
})

async function advancedPerformance(snapshots) {
    const output = {}
    const setters = Object.fromEntries(['XirrLoading', 'RangeStart', 'RangeEnd', 'RealizedTrades', 'TotalWins', 'TotalTrades', 'WinRate', 'AvgHoldingDays', 'Mdd', 'Xirr', 'PerformanceMessage', 'HasLoaded', 'RangeStats', 'YearStats', 'HeatmapData']
        .map(name => ['set' + name, value => { output[name] = value }]))
    const snapshotRef = { current: [] }
    const run = callback('src/pages/invest/YearReview.tsx', 'loadPerformance', {
        ...calc, ...performance, ...setters, captureUserSession: () => ({ assertActive() {} }), toLocalDateString: () => '2026-10-05',
        fetchTrades: async () => [], fetchDividends: async () => [],
        fetchCashflow: async () => [{ date: '2025-10-05', type: 'in', amount: 100000 }], fetchAssetSnapshots: async () => snapshots,
        performanceSnapshotsRef: snapshotRef, performanceCashflowsRef: { current: [] }, console: { error: error => { throw error } },
    })
    await run()
    return { ...output, snapshots: snapshotRef.current }
}

test('R03/R07 recheck: advanced returns never select a future snapshot as current closing NAV', async () => {
    const output = await advancedPerformance([close('2025-10-05', 100000), close('2026-10-05', 120000), close('2027-10-05', 999999)])
    near(output.Xirr, 0.2)
    assert.equal(output.snapshots.at(-1).date, '2026-10-05')
    assert.match(output.PerformanceMessage, /2026-10-05/)
})

test('R03/R07 recheck: duplicate closing endpoints cannot supply an apparently valid full-history XIRR', async () => {
    const output = await advancedPerformance([close('2025-10-05', 100000), close('2026-10-05', 120000), close('2026-10-05', 120001)])
    assert.equal(output.Xirr, null)
    assert.equal(output.Mdd, null)
    assert.match(output.PerformanceMessage, /重複/)
})

test('R06 recheck: mixed cash/credit distributions conserve cost and debt through repeated partial closes', () => {
    const first = { ...buy, fee: 100, total: 40100 }
    const second = { ...buy, id: 'second', date: '2026-01-06', price: 200, fee: 200, marginAmount: 120000, total: 80200 }
    for (const marginShares of [0, 1, 50, 100, 199, 200]) {
        const dividends = [{ ...div, stockDividend: 200, stockDividendMarginShares: marginShares }]
        const trades = [first, second]
        for (const [i, shares] of [333, 2000 + marginShares - 333].entries()) {
            const sale = { ...sell, id: 'credit-sell-' + i, date: `2026-03-0${3 + i}`, shares }
            const estimate = calc.estimateMarginRepayment(sale, trades, dividends)
            assert.equal(estimate.unmatchedShares, 0)
            sale.marginPrincipal = estimate.principal; sale.marginRepay = estimate.principal
            sale.total = calc.calcTradeTotal(sale)
            trades.push(sale)
            const canonical = calc.calcPositions(trades, dividends).holdings['2330']
            const aggregate = calc.aggregateMarginPositions(trades, undefined, dividends)[0]
            assert.equal(canonical.marginAmount, aggregate?.marginAmount ?? 0)
        }
        if (marginShares < 200) {
            const sale = { ...sell, id: 'cash-sell', date: '2026-03-05', isMargin: false, shares: 200 - marginShares, marginPrincipal: 0, marginRepay: 0 }
            sale.total = calc.calcTradeTotal(sale)
            trades.push(sale)
        }
        const result = calc.calcPositions([...trades].reverse(), dividends)
        near(result.realized.reduce((sum, row) => sum + row.avgCost * row.shares, 0), 300300)
        assert.equal(result.holdings['2330'].shares, 0)
        assert.equal(result.holdings['2330'].totalCost, 0)
        assert.equal(calc.aggregateMarginDebt(trades, undefined, dividends), 0)
        const account = portfolio.buildPortfolioSnapshot({ asOf: '2026-03-05', trades, dividends,
            cashflow: [{ date: buy.date, type: 'in', amount: 120300 }], savedPrices: {} })
        near(account.netAssets, 40000)
        near(account.netAssets - 120300, result.realized.reduce((sum, row) => sum + row.realized, 0))
    }
})

test('R06 recheck: credit bonus shares cannot silently fund a cash-category sale', () => {
    const dividends = [{ ...div, stockDividendMarginShares: 100 }]
    const cashSale = { ...sell, isMargin: false, shares: 100 }
    assert.equal(calc.calcSharesBeforeTrade(cashSale, [buy], dividends), 0)
    assert.throws(() => calc.calcPositions([buy, cashSale], dividends), /配股.*融資股數/)
})

test('R05 recheck: per-tag export succeeds under one session and stops remaining downloads on a switch', async () => {
    for (const changeAccount of [false, true]) {
        const h = memoryFirestore(), downloads = [], messages = []
        const loaded = h.captureUserSession()
        const run = callback('src/pages/kms/KMSExport.tsx', 'handleExport', {
            exportingLock: { current: false }, loadedSession: { current: loaded }, format: 'per-tag-txt', filterMode: 'all',
            filteredNotes: [{ id: 'one', title: 'A title', hashtags: ['first', 'second'] }], toLocalDateString: () => '2026-10-05',
            setExporting() {}, setExportProgress() {}, setNotes() {}, setAllTags() {}, setHasLoaded() {}, setLoadError() {},
            fetchKmsBodiesInBatches: async (ids, size, onProgress, session) => { assert.equal(session, loaded); return { one: { content: 'A body' } } },
            formatNote: note => note.title + ':' + note.content,
            downloadFile: content => downloads.push(content),
            setTimeout: done => { if (changeAccount) h.state.uid = 'b'; done() },
            alertAction: message => messages.push(message), console: { error() {} },
        })
        await run()
        assert.equal(downloads.length, changeAccount ? 1 : 2)
        assert.ok(downloads.every(content => content.includes('A title:A body')))
        assert.equal(messages.length, changeAccount ? 1 : 0)
    }
})

test('R07 daily snapshot refresh accepts either quality and retains one record for that date', async () => {
    for (const closeFirst of [false, true]) {
        const h = memoryFirestore()
        const mod = compile(read('src/lib/snapshot.ts'), h.bindings)
        const intraday = { ...close('2026-10-05', 100), valuationQuality: 'intraday' }
        const closing = close('2026-10-05', 120)
        const values = closeFirst ? [closing, intraday] : [intraday, closing]
        await Promise.allSettled(values.map(value => mod.saveValuationSnapshot(value)))
        assert.deepEqual(h.store.get('users/a/assetSnapshots/2026-10-05'), values.at(-1))
    }
})

test('R06 recheck: invalid legacy classifications report an error without crashing the trade repair form', () => {
    const run = callback('src/pages/invest/Trades.tsx', 'sellMarginWarning', {
        ...calc, form: { ...sell, isMargin: false }, trades: [buy, sell], dividends: [div],
    })
    assert.match(run(), /配股.*融資股數/)
})

test('R06 recheck: annual review exposes the ledger error instead of displaying empty or stale totals', async () => {
    let message = '', hasLoaded = false
    const monthly = callback('src/pages/invest/YearReview.tsx', 'calcMonthlyForYear', { ...calc, toLocalDateString: () => '2026-10-05', setMonthlyData() {} })
    const run = callback('src/pages/invest/YearReview.tsx', 'load', {
        selectedYear: 2026, rawDataLoadedRef: { current: true }, allTradesRef: { current: [buy, sell] }, allDividendsRef: { current: [div] },
        assetSnapshots: {}, allCashflowsRef: { current: [] }, captureUserSession: () => ({ assertActive() {} }),
        calcMonthlyForYear: monthly, setLoading() {}, setLoadError: value => { message = value }, setHasLoaded: value => { hasLoaded = value },
        console: { error() {} },
    })
    await run()
    assert.match(message, /配股.*融資股數/)
    assert.equal(hasLoaded, false)
})
