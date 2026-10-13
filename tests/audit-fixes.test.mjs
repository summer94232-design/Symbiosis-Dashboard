import test from 'node:test'
import assert from 'node:assert/strict'
import { initializeApp, deleteApp } from 'firebase/app'
import { getFirestore, writeBatch, doc } from 'firebase/firestore'
import { compile, read } from './helpers/compile.mjs'
import { memoryFirestore } from './helpers/memory-firestore.mjs'

const calc = compile(read('src/lib/calc.ts'))
const csv = compile(read('src/lib/csv.ts'))
const dayCsv = compile(read('src/lib/dayTradeCsv.ts'), calc)
const validation = compile(read('src/lib/investmentValidation.ts'), calc)
const integrity = compile(read('src/lib/ledgerIntegrity.ts'), calc)
const search = compile(read('src/lib/kmsSearch.ts'))
const trade = (overrides = {}) => {
    const row = { date: '2026-09-01', type: 'buy', code: '2330', name: 'fixture', price: 100, shares: 1000, fee: 0, tax: 0, ...overrides }
    return { ...row, total: calc.calcTradeTotal(row) }
}
const ledger = seed => {
    const h = memoryFirestore(seed)
    return { ...h, ...compile(read('src/lib/ledgerWrites.ts'), { ...calc, ...validation, ...integrity, ...h.bindings }) }
}
const kms = seed => {
    const h = memoryFirestore(seed)
    return { ...h, ...compile(read('src/lib/kmsImport.ts'), { ...csv, ...search, ...h.bindings }) }
}

test('A08: whole-file CSV preserves multiline text, commas, escaped quotes, BOM and empty trailing fields', () => {
    assert.deepEqual(csv.parseCSVRecords('\uFEFFtitle,content,url\r\n"甲"," 第一行,\r\n第二行""引號"" ",\r\n\r\n乙,普通文字,'),
        [['title', 'content', 'url'], ['甲', ' 第一行,\n第二行"引號" ', ''], ['乙', '普通文字', '']])
    for (const input of ['a,"broken', 'a,"closed"bad', 'a,b"bad']) assert.throws(() => csv.parseCSVRecords(input), /CSV/)
})

test('A01/A07/A08: KMS commits note and complete body to the pinned account and passes real SDK serialization', async () => {
    const app = initializeApp({ projectId: 'demo-audit-fixes' }, 'audit-fixes-serialization')
    try {
        const h = kms(), db = getFirestore(app)
        h.state.serialize = (path, data) => assert.doesNotThrow(() => writeBatch(db).set(doc(db, path), data))
        const result = await h.importKmsNotes('標題,內容,網址\n甲,"第一行\n第二行,含逗號",\n乙,只有文字,', 'notes.csv')
        assert.deepEqual(result, { success: 2, duplicated: 0, skipped: 0, failed: 0 })
        const notes = [...h.store].filter(([path]) => path.includes('/notes/'))
        assert.equal(notes.length, 2); assert.ok(notes.every(([, note]) => !Object.hasOwn(note, 'url')))
        assert.equal([...h.store].find(([path]) => path.includes('/noteBodies/'))[1].content, '第一行\n第二行,含逗號')
    } finally { await deleteApp(app) }
})

test('A01: account changes during file reading cause no KMS import; the synchronous lock blocks a second import', async () => {
    const source = read('src/pages/kms/KMSHome.tsx')
    const body = source.slice(source.indexOf('    const handleImportNotes ='), source.indexOf('    //', source.indexOf('    const handleImportNotes =') + 100))
    // Locate the full callback even if following comments change.
    const end = source.indexOf('\n    const ', source.indexOf('    const handleImportNotes =') + 20)
    const h = kms(), state = { message: '', calls: 0 }, lock = { current: false }
    const fn = compile(end > 0 ? source.slice(source.indexOf('    const handleImportNotes ='), end) : body, {
        ...h.bindings, noteImportLock: lock, setImporting() {}, setImportMsg: msg => { state.message = msg },
        importKmsNotes: async () => { state.calls++; return { success: 0 } }, invalidateKmsNotes() {}, onNotesChanged() {}, load() {},
    }, 'export { handleImportNotes }').handleImportNotes
    let release
    const gate = new Promise(resolve => { release = resolve })
    const input = { value: 'selected', files: [{ name: 'n.json', text: async () => { await gate; h.state.uid = 'b'; return '[]' } }] }
    const running = fn({ target: input })
    await fn({ target: input }); assert.equal(lock.current, true)
    release(); await running
    assert.equal(state.calls, 0); assert.match(state.message, /登入帳號已變更/)
    assert.equal(lock.current, false); assert.equal(input.value, '')
})

test('A01: switching accounts after the first confirmed KMS commit stops before the next row', async () => {
    const h = kms()
    h.state.afterCommit = () => { h.state.uid = 'b' }
    const result = await h.importKmsNotes('[{"title":"甲"},{"title":"乙"}]', 'n.json')
    assert.equal(result.success, 1); assert.match(result.error, /登入帳號已變更/)
    assert.equal(h.commits.length, 1); assert.ok([...h.store.keys()].every(path => path.startsWith('users/a/')))
})

test('A09: lost acknowledgement stops the import; retry and concurrent repeats keep exactly two notes', async () => {
    const h = kms(), text = '[{"title":"甲","content":"完整正文"},{"title":"乙"}]'
    h.state.afterCommit = () => { throw Error('lost acknowledgement') }
    const first = await h.importKmsNotes(text, 'n.json')
    assert.equal(first.failed, 1); assert.equal(first.success, 0); assert.match(first.error, /寫入未確認/)
    assert.equal(h.commits.length, 1)
    h.state.afterCommit = null
    const results = await Promise.all([h.importKmsNotes(text, 'n.json'), h.importKmsNotes(text, 'n.json')])
    assert.equal(results.reduce((sum, row) => sum + row.success, 0), 1)
    assert.equal([...h.store.keys()].filter(path => path.includes('/notes/')).length, 2)
    const repeated = await h.importKmsNotes(text, 'n.json')
    assert.equal(repeated.duplicated, 2); assert.equal(repeated.success, 0)
    const path = [...h.store.keys()].find(path => path.includes('/notes/'))
    h.store.delete(path)
    assert.equal((await h.importKmsNotes(text, 'n.json')).duplicated, 2)
    assert.equal(h.store.has(path), false, 'receipt prevents deleted note resurrection')
})

test('A07/A08: malformed CSV is rejected before KMS writes; omitted URL and uppercase JSON filenames remain valid', async () => {
    const h = kms()
    const bad = await h.importKmsNotes('標題,內容\n甲,"未結束', 'n.csv')
    assert.match(bad.error, /引號未關閉/); assert.equal(h.commits.length, 0)
    assert.equal((await h.importKmsNotes('\uFEFF{"notes":[{"title":"標題"}]}', 'N.JSON')).success, 1)
})

test('A02: two devices selling 600 from 1000 shares can commit only one sale', async () => {
    const h = ledger({ 'users/a/trades/buy': trade() })
    const sale = trade({ date: '2026-09-02', type: 'sell', shares: 600 })
    const results = await Promise.allSettled(['sell-a', 'sell-b'].map(id => h.commitLedgerWrites([{ collection: 'trades', id, data: sale, mode: 'create' }])))
    assert.equal(results.filter(row => row.status === 'fulfilled').length, 1)
    assert.match(results.find(row => row.status === 'rejected').reason.message, /缺少 200 股/)
    const rows = [...h.store].filter(([path]) => path.includes('/trades/')).map(([path, row]) => ({ ...row, id: path.split('/').at(-1) }))
    assert.equal(calc.calcPositions(rows).holdings['2330'].shares, 400)
    assert.equal(h.store.get('users/a/ledgerControl/revision').revision, 1)
})

test('A02: a stale second device thirty minutes later uses current inventory; sufficient quantity and a new prior-date purchase both succeed', async () => {
    const h = ledger({ 'users/a/trades/buy': trade() })
    const write = (id, shares, time) => ({ collection: 'trades', id, data: trade({ date: '2026-09-02', type: 'sell', shares, createdAt: time }), mode: 'create' })
    await h.commitLedgerWrites([write('first', 600, '2026-09-02T01:00:00Z')])
    await assert.rejects(h.commitLedgerWrites([write('second', 600, '2026-09-02T01:30:00Z')]), /缺少 200 股/)
    await h.commitLedgerWrites([write('remaining', 400, '2026-09-02T01:30:00Z')])
    assert.equal(h.store.get('users/a/ledgerControl/revision').revision, 2)

    const replenished = ledger({ 'users/a/trades/buy': trade() })
    await replenished.commitLedgerWrites([write('first', 600, '2026-09-02T01:00:00Z')])
    await replenished.commitLedgerWrites([{ collection: 'trades', id: 'missing-purchase', data: trade({ shares: 300 }), mode: 'create' }])
    await replenished.commitLedgerWrites([write('second', 600, '2026-09-02T01:30:00Z')])
    const rows = [...replenished.store].filter(([path]) => path.includes('/trades/')).map(([path, row]) => ({ ...row, id: path.split('/').at(-1) }))
    assert.equal(calc.calcPositions(rows).holdings['2330'].shares, 100)
})

test('Yuanta inventory: cash sales cannot use financing stock, financing sales cannot use cash stock, and valid sales conserve financing debt', async () => {
    const margin = trade({ id: 'margin', isMargin: true, marginRatio: 0.6 })
    const cash = trade({ id: 'cash', shares: 400 })
    const sell = trade({ id: 'sell', date: '2026-09-02', type: 'sell', shares: 600 })
    assert.equal(calc.calcSharesBeforeTrade(sell, [cash, margin]), 400)
    const h = ledger({ 'users/a/trades/cash': cash, 'users/a/trades/margin': margin })
    await assert.rejects(h.commitLedgerWrites([{ collection: 'trades', id: 'sell', data: sell, mode: 'create' }]), /缺少 200 股/)
    const cashOnly = ledger({ 'users/a/trades/cash': trade() })
    await assert.rejects(cashOnly.commitLedgerWrites([{ collection: 'trades', id: 'margin-sale', data: trade({ date: '2026-09-02', type: 'sell', isMargin: true, marginRatio: 0.6, marginRepay: 60000, marginPrincipal: 60000, marginInterest: 0 }), mode: 'create' }]), /缺少 1000 股/)
    await h.commitLedgerWrites([{ collection: 'trades', id: 'sell-valid', data: trade({ date: '2026-09-02', type: 'sell', shares: 400 }), mode: 'create' }])
    const rows = [...h.store].filter(([path]) => path.includes('/trades/')).map(([path, row]) => ({ ...row, id: path.split('/').at(-1) }))
    assert.equal(calc.aggregateMarginDebt(rows), 60000)
    assert.equal(calc.calcPositions(rows).holdings['2330'].shares, 1000)
})

test('Yuanta odd lots: same-day purchases do not fund odd-lot sales or an odd-lot purchase combined into a full lot; next-day sale is allowed', async () => {
    const older = trade({ id: 'older', shares: 200, date: '2026-08-31' })
    const today = trade({ id: 'today', shares: 800 })
    const sale = trade({ id: 'sale', type: 'sell' })
    assert.equal(calc.calcSharesBeforeTrade(sale, [older, today]), 200)
    const h = ledger({ 'users/a/trades/older': older, 'users/a/trades/today': today })
    await assert.rejects(h.commitLedgerWrites([{ collection: 'trades', id: 'sale', data: sale, mode: 'create' }]), /缺少 800 股/)
    await h.commitLedgerWrites([{ collection: 'trades', id: 'sale', data: { ...sale, date: '2026-09-02' }, mode: 'create' }])
    assert.equal(h.store.get('users/a/trades/sale').shares, 1000)
    const regularBuy = trade({ id: 'regular' })
    assert.equal(calc.calcSharesBeforeTrade(trade({ id: 'odd-sale', type: 'sell', shares: 600 }), [regularBuy]), 0)
    const explicitOdd = trade({ id: 'aggregated-odd', shares: 2000, tradingSession: 'odd' })
    assert.equal(calc.calcSharesBeforeTrade(trade({ id: 'whole-sale', type: 'sell', shares: 2000 }), [explicitOdd]), 0)
})

test('Yuanta day trades: eligible whole-lot same-day round trips remain allowed, pending sell-first is explicit, and exclusion preserves old inventory accounting', async () => {
    const buy = trade({ id: 'today' }), sale = trade({ id: 'sale', type: 'sell' })
    assert.equal(calc.calcSharesBeforeTrade(sale, [buy]), 1000)
    const h = ledger({ 'users/a/trades/today': buy })
    await h.commitLedgerWrites([{ collection: 'trades', id: 'sale', data: sale, mode: 'create' }])
    const pending = ledger()
    await pending.commitLedgerWrites([{ collection: 'trades', id: 'pending', data: { ...sale, dayTradePending: true }, mode: 'create' }])
    assert.equal(calc.calcPositions([{ ...sale, dayTradePending: true }]).realized.length, 0)
    assert.equal(validation.validateTradeForWrite({ ...sale, shares: 600, dayTradePending: true }).valid, false)
    const excluded = { ...sale, dayTradeExcluded: true }
    assert.equal(calc.calcSharesBeforeTrade(excluded, [buy]), 0)
    const older = trade({ id: 'older', date: '2026-08-31', price: 90 })
    assert.equal(calc.calcSharesBeforeTrade(excluded, [older, buy]), 1000)
    assert.equal(calc.analyzeDayTrades([older, buy, excluded]).automatic.length, 0)
})

test('Stock distribution: selling the original shares after ex-rights does not erase a confirmed later distribution; received odd shares can be sold on distribution date', async () => {
    const buy = trade({ id: 'original-buy', date: '2026-08-01' })
    const sale = trade({ id: 'original-sale', date: '2026-08-21', type: 'sell' })
    const dividend = { id: 'distribution', date: '2026-08-20', stockDistributionDate: '2026-09-01', status: 'confirmed', code: '2330', name: 'fixture', cashDividend: 0, stockDividend: 100 }
    const result = calc.calcPositions([buy, sale], [dividend], { asOf: '2026-09-01' })
    assert.equal(result.holdings['2330'].shares, 100)
    assert.equal(result.holdings['2330'].totalCost, 0)
    assert.equal(calc.calcPositions([buy, sale], [dividend], { asOf: '2026-08-31' }).holdings['2330'].shares, 0)
    assert.equal(calc.calcPositions([buy, sale], [{ ...dividend, status: 'announced' }]).holdings['2330'].shares, 0)
    const h = ledger({ 'users/a/trades/original-buy': buy, 'users/a/trades/original-sale': sale, 'users/a/dividends/distribution': dividend })
    await h.commitLedgerWrites([{ collection: 'trades', id: 'distribution-sale', data: trade({ date: '2026-09-01', type: 'sell', shares: 100 }), mode: 'create' }])
    assert.equal(h.store.get('users/a/trades/distribution-sale').shares, 100)
    await assert.rejects(h.commitLedgerWrites([{ collection: 'dividends', id: 'distribution' }]), /缺少 100 股/)
})

test('A02: concurrent sale and buy reduction cannot leave an oversold ledger', async () => {
    const h = ledger({ 'users/a/trades/buy': trade() })
    const results = await Promise.allSettled([
        h.commitLedgerWrites([{ collection: 'trades', id: 'sell', data: trade({ date: '2026-09-02', type: 'sell', shares: 800 }), mode: 'create' }]),
        h.commitLedgerWrites([{ collection: 'trades', id: 'buy', data: trade({ shares: 500 }), mode: 'update' }]),
    ])
    assert.equal(results.filter(row => row.status === 'fulfilled').length, 1)
    const rows = [...h.store].filter(([path]) => path.includes('/trades/')).map(([path, row]) => ({ ...row, id: path.split('/').at(-1) }))
    assert.doesNotThrow(() => integrity.assertNoNewOversells({ trades: [], dividends: [] }, { trades: rows, dividends: [] }))
})

test('A02: removing stock dividends that fund sales and overwriting a changed day-trade draft are blocked', async () => {
    const dividend = { date: '2026-09-01', code: '2330', cashDividend: 0, stockDividend: 1000 }
    const h = ledger({ 'users/a/dividends/div': dividend, 'users/a/trades/buy': trade(), 'users/a/trades/sell': trade({ date: '2026-09-02', type: 'sell', shares: 2000 }) })
    await assert.rejects(h.commitLedgerWrites([{ collection: 'dividends', id: 'div' }]), /缺少 1000 股/)
    const current = h.store.get('users/a/trades/sell')
    await assert.rejects(h.commitLedgerWrites([{ collection: 'trades', id: 'sell', data: current, mode: 'update', expected: { ...current, price: 99 } }]), /成交資料已變更/)
    assert.equal(h.commits.length, 0)
})

test('A02: stable-ID trade retry is idempotent after lost acknowledgement; ID collisions do not overwrite data', async () => {
    const h = ledger(), write = { collection: 'trades', id: 'fixed', data: trade(), mode: 'create' }
    h.state.afterCommit = () => { throw Error('lost acknowledgement') }
    await assert.rejects(h.commitLedgerWrites([write]), /lost/)
    h.state.afterCommit = null
    await h.commitLedgerWrites([{ ...write, data: { ...write.data, createdAt: 'new retry time', sequence: 99 } }])
    assert.equal(h.store.get('users/a/ledgerControl/revision').revision, 1)
    await assert.rejects(h.commitLedgerWrites([{ ...write, data: trade({ price: 101 }) }]), /不同資料/)
})

test('A02: paired restore edits commit together; a 401-row restore plans safe intermediate states', async () => {
    const h = ledger({ 'users/a/trades/buy': trade(), 'users/a/trades/sell': trade({ date: '2026-09-02', type: 'sell' }) })
    await h.commitLedgerRestore([
        { collection: 'trades', id: 'buy', data: trade({ shares: 500 }), mode: 'upsert' },
        { collection: 'trades', id: 'sell', data: trade({ date: '2026-09-02', type: 'sell', shares: 500 }), mode: 'upsert' },
    ])
    assert.equal(h.store.get('users/a/trades/sell').shares, 500)
    const large = ledger(), writes = [
        { collection: 'trades', id: 'sale', data: trade({ date: '2026-09-02', type: 'sell', shares: 100 }), mode: 'upsert' },
        ...Array.from({ length: 400 }, (_, i) => ({ collection: 'trades', id: String(i), data: trade({ shares: 1 }), mode: 'upsert' })),
    ]
    const counts = []; await large.commitLedgerRestore(writes, large.captureUserSession(), count => counts.push(count))
    assert.deepEqual(counts, [400, 1]); assert.equal(large.store.get('users/a/ledgerControl/revision').revision, 2)
})

test('A03: CSV preserves designated purchase lots and realized profit, with no invented allocation for legacy rows', () => {
    const rows = [trade({ id: 'first' }), trade({ id: 'second', date: '2026-09-02', price: 200 }),
        trade({ id: 'sale', date: '2026-09-03', type: 'sell', price: 300, inventoryMatches: [{ buyId: 'second', shares: 1000 }] })]
    const roundTrip = rows.map(row => ({ ...row, ...dayCsv.importDayTradeFields(dayCsv.exportDayTradeFields(row)) }))
    assert.deepEqual(calc.calcPositions(roundTrip), calc.calcPositions(rows))
    assert.equal(calc.calcPositions(roundTrip).realized[0].realized, 100000)
    assert.equal(dayCsv.importDayTradeFields({}).inventoryMatches, undefined)
    for (const links of [[], [{ buyId: 'bad/path', shares: 1 }], [{ buyId: 'first', shares: -1 }]]) {
        assert.throws(() => dayCsv.importDayTradeFields({ '指定庫存沖抵': JSON.stringify(links) }), /指定庫存沖抵/)
    }
})

function investmentImport(page, text) {
    const h = ledger(), state = { result: null }
    const source = read(`src/pages/invest/${page}.tsx`)
    const name = page === 'Trades' ? 'handleImportCSV' : 'handleImportTradesCSV'
    const start = source.indexOf(`    const ${name} =`)
    const end = page === 'Trades' ? source.indexOf('    const dayTradeAnalysis =', start) : source.indexOf('    // ── 匯入出入金', start)
    const setResult = result => { state.result = result }
    const mod = compile(source.slice(start, end), { ...calc, ...csv, ...dayCsv, ...validation, ...h.bindings,
        commitLedgerWrites: h.commitLedgerWrites, getDocs: h.bindings.getDocsFromServer,
        setDoc: async (path, data) => h.store.set(path, data),
        doc: () => ({ id: 'generated-' + h.commits.length }), dividends: [], marginRules: {},
        importLock: { current: false }, restoring: false,
        setImporting() {}, setTradeImporting() {}, setImportResult: setResult, setTradeImportResult: setResult,
        showMsg() {}, saveStockName: async () => {}, cacheStockName() {}, cache: { invalidatePrefix() {} },
        invalidateTrades() {}, invalidateCashflow() {}, load() {},
    }, `export { ${name} }`)
    return { ...h, state, run: () => mod[name]({ target: { value: 'selected', files: [{ text: async () => text }] } }) }
}

for (const page of ['Trades', 'InvestSettings']) {
    test(`A06/A08: ${page} honors actual fees and zero taxes and preserves multiline notes`, async () => {
        const h = investmentImport(page, '日期,類型,代號,名稱,價格,股數,手續費,交易稅,收付金額,備註\n2026-09-01,買入,2330,fixture,100,1000,50,0,100050,"第一行\n第二行,含逗號"\n2026-09-02,賣出,2330,fixture,100,1000,50,0,,完成')
        await h.run(); assert.equal(h.state.result.success, 2); assert.equal(h.state.result.error, undefined)
        const rows = [...h.store].filter(([path]) => path.includes('/trades/')).map(([, row]) => row)
        assert.equal(rows[0].fee, 50); assert.equal(rows[0].total, 100050)
        assert.equal(rows[0].note, '第一行\n第二行,含逗號')
        assert.equal(rows[1].tax, 0); assert.equal(rows[1].total, 99950)
    })

    test(`A03: ${page} CSV round trip restores source IDs and designated inventory profit`, async () => {
        const rows = [trade({ id: 'first' }), trade({ id: 'second', date: '2026-09-02', price: 200 }),
            trade({ id: 'sale', date: '2026-09-03', type: 'sell', price: 300, inventoryMatches: [{ buyId: 'second', shares: 1000 }] })]
        const fields = rows.map(row => ({ 'Firestore ID': row.id, 日期: row.date, 類型: row.type === 'buy' ? '買入' : '賣出',
            代號: row.code, 名稱: row.name, 價格: row.price, 股數: row.shares, 手續費: row.fee, 交易稅: row.tax, 收付金額: row.total, ...dayCsv.exportDayTradeFields(row) }))
        const quote = value => '"' + String(value).replaceAll('"', '""') + '"'
        const headers = Object.keys(fields[0])
        const text = [headers, ...fields.map(row => headers.map(key => row[key]))].map(row => row.map(quote).join(',')).join('\n')
        const h = investmentImport(page, text); await h.run()
        assert.equal(h.state.result.success, 3); assert.equal(h.state.result.error, undefined)
        const restored = [...h.store].filter(([path]) => path.includes('/trades/')).map(([path, row]) => ({ ...row, id: path.split('/').at(-1) }))
        assert.equal(calc.calcPositions(restored).realized[0].realized, 100000)
        assert.equal(calc.calcPositions(restored).holdings['2330'].totalCost, 100000)
        assert.deepEqual(restored.find(row => row.id === 'sale').inventoryMatches, rows[2].inventoryMatches)
    })
}

test('A05: bond ETF exemption respects transaction dates and suffixes; stock, equity ETF and leveraged/inverse rates remain correct', () => {
    for (const code of ['00679B', '00679b.tw', '00696B.TWO', '00771C']) {
        assert.equal(calc.calcTax(100, 1000, code, '2026-12-31'), 0)
        assert.equal(calc.calcTax(100, 1000, code, '2017-01-01'), 0)
        assert.equal(calc.calcTax(100, 1000, code, '2016-12-31'), 100)
        assert.equal(calc.calcTax(100, 1000, code, '2027-01-01'), 100)
    }
    for (const code of ['0050', '00679L', '00679R', '00980D']) assert.equal(calc.calcTax(100, 1000, code, '2026-10-01'), 100)
    assert.equal(calc.calcTax(100, 1000, '2330.TW', '2026-10-01'), 300)
    const position = { code: '00679B', shares: 1000, totalCost: 90000, marginAmount: 0 }
    assert.equal(calc.calcHoldingValuation(position, 100, '2026-10-01').estimatedSellTax, 0)
    assert.equal(calc.calcHoldingValuation(position, 100, '2027-01-01').estimatedSellTax, 100)
})

const calendarHarness = seed => {
    const h = memoryFirestore(seed)
    const mod = compile(read('src/lib/googleCalendar.ts'), {
        ...h.bindings, ...compile(read('src/lib/date.ts')), getDocs: h.bindings.getDocsFromServer,
    }, 'export { reconcileATypeEvents }')
    return { ...h, ...mod }
}
test('A04: cancelled Google event retains local pending edits and marks an explicit conflict without pushing or deleting', async () => {
    const event = { title: '本機修改', type: 'personal', date: '2026-10-01', updatedAt: 'new', googleEventId: 'g', googlePendingLocalChange: true }
    const h = calendarHarness({ 'users/a/calendarEvents/local': event })
    const result = await h.reconcileATypeEvents(['personal'], [{ googleEventId: 'g', sourceId: 'local', cancelled: true }])
    assert.deepEqual(result.firestoreDeletes, []); assert.deepEqual(result.pushList, [])
    assert.equal(result.firestoreUpdates[0].data.googleSyncConflict, 'remote-deleted')
    assert.match(result.warnings[0], /本機修改.*保留/)
    const clean = calendarHarness({ 'users/a/calendarEvents/local': { ...event, googlePendingLocalChange: false } })
    assert.deepEqual((await clean.reconcileATypeEvents(['personal'], [{ googleEventId: 'g', sourceId: 'local', cancelled: true }])).firestoreDeletes, ['local'])
})

test('A04: retain resolution makes a new source with the complete edited content; accept resolution deletes, and stale resolution is rejected', async () => {
    const event = { id: 'local', title: '保留修改', date: '2026-10-01', type: 'personal', description: '正文', updatedAt: 'revision', googleEventId: 'g', googleSyncConflict: 'remote-deleted' }
    const h = calendarHarness({ 'users/a/calendarEvents/local': event })
    await h.resolveGoogleDeletionConflict(event, { title: '最後修改' })
    assert.equal(h.store.has('users/a/calendarEvents/local'), false)
    const saved = h.store.get('users/a/calendarEvents/replacement-0')
    assert.equal(saved.title, '最後修改'); assert.equal(saved.description, '正文'); assert.equal(saved.googleEventId, undefined)
    assert.equal(saved.googlePendingLocalChange, true)
    await assert.rejects(h.resolveGoogleDeletionConflict(event, { title: '重試' }), /已變更或衝突已處理/)
    const drop = calendarHarness({ 'users/a/calendarEvents/local': event })
    await drop.resolveGoogleDeletionConflict(event); assert.equal(drop.store.size, 0)
    const stale = calendarHarness({ 'users/a/calendarEvents/local': { ...event, updatedAt: 'other' } })
    await assert.rejects(stale.resolveGoogleDeletionConflict(event), /已變更/); assert.equal(stale.store.size, 1)
})

test('A04: conversion to a Google series also preserves the pending local parent', async () => {
    const h = calendarHarness({ 'users/a/calendarEvents/local': { title: '尚未同步修改', type: 'personal', date: '2026-10-01', googleEventId: 'series', googlePendingLocalChange: true } })
    const result = await h.reconcileATypeEvents(['personal'], [{ googleEventId: 'occurrence', recurringEventId: 'series', sourceId: null, date: '2026-10-02', title: '重複行程' }])
    assert.deepEqual(result.firestoreDeletes, [])
    assert.equal(result.firestoreUpdates[0].data.googleSyncConflict, 'remote-deleted')
})

test('A04: calendar conflict actions preserve edits and request synchronization only after a successful keep', async () => {
    const source = read('src/pages/calendar/CalendarHome.tsx')
    const body = source.slice(source.indexOf('    const handleResolveGoogleDeletion ='), source.indexOf('    const handleUpdateEvent ='))
    for (const keep of [true, false]) {
        const calls = [], session = { assertActive() {} }
        const mod = compile(body, { editingEvent: { id: 'local' }, form: { title: '目前修改', date: '2026-10-01' }, timing: {},
            mutation: { run: fn => fn(session) }, timingForWrite: () => { calls.push('timing'); return { start: { date: '2026-10-01' } } },
            resolveGoogleDeletionConflict: async (_, data) => { calls.push(data ? 'keep' : 'delete'); if (data) assert.equal(data.title, '目前修改') },
            invalidateCalendarEvents() {}, setEditingEvent() {}, loadPersonal: async () => {}, handleSyncGoogleCalendar: async () => calls.push('sync'),
        }, 'export { handleResolveGoogleDeletion }')
        await mod.handleResolveGoogleDeletion(keep)
        assert.deepEqual(calls, keep ? ['timing', 'keep', 'sync'] : ['delete'])
    }
})
