import test from 'node:test'
import assert from 'node:assert/strict'
import { compile, read } from './helpers/compile.mjs'

const calc = compile(read('src/lib/calc.ts'))
const validation = compile(read('src/lib/investmentValidation.ts'), calc)
const integrity = compile(read('src/lib/ledgerIntegrity.ts'), calc)
const trade = (overrides = {}) => ({ date: '2026-09-01', type: 'buy', code: '2330', name: 'fixture',
    price: 100, shares: 1000, fee: 0, tax: 0, total: 100000, ...overrides })
const doc = (id, data) => ({ id, data })
const snapshot = rows => ({ docs: rows.map(row => ({ id: row.id, data: () => row.data })) })

function restoreHarness({ current = {}, onRead = () => {}, onCommit = () => {} } = {}) {
    const writes = [], state = { active: true, batches: 0 }
    const session = { uid: 'a', assertActive() { if (!state.active) throw Error('account changed') },
        col(_, col) { this.assertActive(); return col },
        doc(_, col, id) { this.assertActive(); return `${col}/${id}` } }
    const mod = compile(read('src/lib/backup.ts'), { ...calc, ...validation, ...integrity,
        captureUserSession: () => session, investDB: 'invest', kmsDB: 'kms', invalidateAllInvestData() {},
        getDocsFromServer: async col => { await onRead(col, state); return snapshot(current[col] || []) },
        commitLedgerRestore: async (rows, session, committed) => {
            state.batches++; session.assertActive();
            writes.push(...rows.map(row => ({ path: session.doc('invest', row.collection, row.id), data: row.data })));
            await onCommit(state); session.assertActive(); committed(rows.length)
        },
        writeBatch: () => { state.batches++; const pending = []; return {
            set: (path, data) => pending.push({ path, data }),
            commit: async () => { writes.push(...pending); await onCommit(state) },
        } },
    })
    return { ...mod, writes, state }
}

for (const [name, invest] of [
    ['invalid cash date', { cashflow: [doc('c', { date: '2026-02-30', type: 'in', amount: 100 })] }],
    ['negative cash amount', { cashflow: [doc('c', { date: '2026-09-01', type: 'in', amount: -1 })] }],
    ['fractional cash amount', { cashflow: [doc('c', { date: '2026-09-01', type: 'in', amount: 1.5 })] }],
    ['nonfinite trade price', { trades: [doc('t', trade({ price: NaN }))] }],
    ['trade total mismatch', { trades: [doc('t', trade({ total: 1 }))] }],
    ['invalid share count', { trades: [doc('t', trade({ shares: 1.5 }))] }],
    ['invalid dividend date', { dividends: [doc('d', { date: '2026-09-01', code: '2330', name: 'fixture', cashDividend: 0, stockDividend: 10, stockDistributionDate: '2026-02-30' })] }],
    ['snapshot equation mismatch', { assetSnapshots: [doc('s', { date: '2026-09-01', totalAssets: 1, marketValue: 10, cash: 10 })] }],
    ['invalid financial document ID', { cashflow: [doc('a/b', { date: '2026-09-01', type: 'in', amount: 100 })] }],
    ['duplicate financial ID', { trades: [doc('t', trade()), doc('t', trade())] }],
    ['malformed collection', { trades: {} }],
]) test(`restore rejects ${name} before any batch is created`, async () => {
    const harness = restoreHarness()
    await assert.rejects(harness.restoreFullBackup({ invest, kms: {} }), /還原前檢查.*尚未寫入/)
    assert.equal(harness.state.batches, 0)
    assert.deepEqual(harness.writes, [])
})

test('invalid late accounting row blocks earlier collections and more than 400 otherwise valid rows', async () => {
    const harness = restoreHarness()
    const rows = Array.from({ length: 401 }, (_, i) => doc(String(i), { date: '2026-09-01', type: 'in', amount: 100 }))
    rows.push(doc('bad', { date: 'wrong', type: 'in', amount: -1 }))
    await assert.rejects(harness.restoreFullBackup({ invest: { trades: [doc('buy', trade())], cashflow: rows }, kms: {} }), /第 402 筆/)
    assert.equal(harness.state.batches, 0)
})

test('restore validates merged ledger and blocks reducing a buy that funds an existing sell', async () => {
    const harness = restoreHarness({ current: { trades: [doc('buy', trade()), doc('sell', trade({ date: '2026-09-02', type: 'sell' }))] } })
    await assert.rejects(harness.restoreFullBackup({ invest: { trades: [doc('buy', trade({ shares: 500, total: 50000 }))] }, kms: {} }), /缺少 500 股/)
    assert.equal(harness.state.batches, 0)
})

test('restore blocks new oversells and invalid explicit day-trade references', async () => {
    for (const sale of [trade({ type: 'sell' }), trade({ type: 'sell', dayTradeMatches: [{ buyId: 'absent', shares: 1000 }], dayTradePending: true })]) {
        const harness = restoreHarness()
        await assert.rejects(harness.restoreFullBackup({ invest: { trades: [doc('sell', sale)] }, kms: {} }), /缺少|當沖配對失效/)
        assert.equal(harness.state.batches, 0)
    }
})

test('moving restored stock distribution after an existing sale is rejected', async () => {
    const dividend = { date: '2026-09-01', code: '2330', name: 'fixture', cashDividend: 0, stockDividend: 1000, stockDistributionDate: '2026-09-01' }
    const harness = restoreHarness({ current: { dividends: [doc('d', dividend)], trades: [
        doc('buy', trade({ date: '2026-08-31' })),
        doc('sell', trade({ type: 'sell', date: '2026-09-02', shares: 2000, total: 200000 })),
    ] } })
    await assert.rejects(harness.restoreFullBackup({ invest: { dividends: [doc('d', { ...dividend, stockDistributionDate: '2026-09-03' })] }, kms: {} }), /缺少/)
    assert.equal(harness.state.batches, 0)
})

test('valid upsert, legacy zero fee/tax and negative cash snapshot round trip without rewriting data', async () => {
    const harness = restoreHarness({ current: { trades: [doc('existing', trade())] } })
    const oldTrade = trade({ shares: 100, total: 10000 }); delete oldTrade.fee; delete oldTrade.tax
    const invest = { trades: [doc('legacy', oldTrade)], cashflow: [doc('c', { date: '2026-09-02', type: 'in', amount: 100 })],
        assetSnapshots: [doc('s', { date: '2026-09-02', totalAssets: -10, marketValue: 0, cash: -10 })] }
    await harness.restoreFullBackup({ invest, kms: {} })
    for (const [col, rows] of Object.entries(invest)) for (const row of rows) {
        assert.deepEqual(harness.writes.find(write => write.path === `${col}/${row.id}`).data, row.data)
    }
    assert.ok(!harness.writes.some(write => write.path === 'trades/existing'))
})

test('explicit sell-first pending day trade remains supported', async () => {
    const harness = restoreHarness()
    await harness.restoreFullBackup({ invest: { trades: [doc('pending', trade({ type: 'sell', dayTradePending: true }))] }, kms: {} })
    assert.equal(harness.writes.length, 1)
})

test('server read failure and account switch during preflight both prevent all writes', async () => {
    for (const onRead of [async () => { throw Error('offline') }, async (_, state) => { state.active = false }]) {
        const harness = restoreHarness({ onRead })
        await assert.rejects(harness.restoreFullBackup({ invest: { trades: [doc('t', trade())] }, kms: {} }), /尚未寫入/)
        assert.equal(harness.state.batches, 0)
    }
})

function importHarness({ switchAt, failAt, content } = {}) {
    const investAuth = { currentUser: { uid: 'a' } }, kmsAuth = { currentUser: { uid: 'kms-a' } }
    const state = { stage: 0, result: null, importing: false, loads: 0 }, writes = []
    const boundary = async () => {
        state.stage++
        if (state.stage === switchAt) { investAuth.currentUser = { uid: 'b' }; kmsAuth.currentUser = { uid: 'kms-b' } }
        if (state.stage === failAt) throw Error('fixture read failed')
    }
    const db = compile(read('src/lib/userDB.ts'), { investAuth, kmsAuth,
        collection: (_, ...parts) => parts.join('/'), doc: (_, ...parts) => parts.join('/') })
    const source = read('src/pages/invest/Trades.tsx')
    const body = source.slice(source.indexOf('    const handleImportCSV ='), source.indexOf('    const dayTradeAnalysis ='))
    const csv = compile(read('src/lib/csv.ts'))
    const dayCsv = compile(read('src/lib/dayTradeCsv.ts'), calc)
    const repaymentCsv = compile(read('src/lib/marginRepayment.ts'), calc)
    const mod = compile(body, { ...db, ...csv, ...dayCsv, ...calc, ...validation, ...repaymentCsv, investDB: 'invest', dividends: [], marginRules: {},
        doc: () => ({ id: 'new-' + writes.length }),
        commitLedgerWrites: async (rows, session) => {
            for (const row of rows) { writes.push({ path: session.doc('invest', row.collection, row.id), data: row.data }); await boundary() }
        },
        setImporting: value => { state.importing = value }, setImportResult: value => { state.result = value },
        getDocs: async () => { await boundary(); return { docs: [] } },
        addDoc: async (path, data) => { writes.push({ path, data }); await boundary(); return { id: String(writes.length) } },
        setDoc: async (path, data) => { writes.push({ path, data }); await boundary() },
        saveStockName: async () => { await boundary() },
        invalidateTrades() {}, invalidateCashflow() {}, load: () => { state.loads++ },
    }, 'export { handleImportCSV };')
    const input = { value: 'fixture.csv', files: [{ text: async () => { await boundary(); return content || '日期,類型,金額\n2026-09-01,入金,100\n2026-09-02,入金,200' } }] }
    return { state, writes, input, run: () => mod.handleImportCSV({ target: input }) }
}

for (const switchAt of [1, 2, 4]) test(`CSV account switch at async boundary ${switchAt} aborts without writing to B`, async () => {
    const harness = importHarness({ switchAt })
    await harness.run()
    assert.ok(harness.writes.every(write => write.path.startsWith('users/a/')))
    assert.equal(harness.writes.length, switchAt === 4 ? 1 : 0)
    assert.match(harness.state.result.error, /登入帳號已變更/)
    assert.equal(harness.state.result.success, harness.writes.length)
    assert.equal(harness.state.loads, 0)
    assert.equal(harness.state.importing, false)
    assert.equal(harness.input.value, '')
})

for (const switchAt of [4, 5]) test(`CSV trade write/dictionary switch at boundary ${switchAt} stops remaining trade rows`, async () => {
    const harness = importHarness({ switchAt, content: '日期,類型,代號,名稱,價格,股數\n2026-09-01,買入,2330,fixture,100,1000\n2026-09-02,買入,2330,fixture,101,1000' })
    await harness.run()
    assert.equal(harness.writes.length, 1)
    assert.equal(harness.writes[0].path, 'users/a/trades/new-0')
    assert.equal(harness.state.result.success, 1)
    assert.match(harness.state.result.error, /登入帳號已變更/)
})

test('CSV read failure resets loading and reports interruption', async () => {
    const harness = importHarness({ failAt: 1 })
    await harness.run()
    assert.equal(harness.state.importing, false)
    assert.equal(harness.input.value, '')
    assert.match(harness.state.result.error, /fixture read failed/)
    assert.equal(harness.writes.length, 0)
})

test('CSV normal cash-flow import keeps both rows in the starting account', async () => {
    const harness = importHarness()
    await harness.run()
    assert.deepEqual(harness.state.result, { success: 2, failed: 0, skipped: 0, duplicated: 0 })
    assert.equal(harness.writes.length, 2)
    assert.ok(harness.writes.every(write => write.path === 'users/a/cashflow'))
    assert.equal(harness.state.loads, 1)
    assert.equal(harness.state.importing, false)
})

test('CSV dictionary failure reports a committed trade once and stops remaining rows', async () => {
    const harness = importHarness({ failAt: 5, content: '日期,類型,代號,名稱,價格,股數\n2026-09-01,買入,2330,fixture,100,1000\n2026-09-02,買入,2330,fixture,101,1000' })
    await harness.run()
    assert.equal(harness.writes.length, 1)
    assert.equal(harness.state.result.success, 1)
    assert.equal(harness.state.result.failed, 0)
    assert.match(harness.state.result.error, /交易已匯入.*股票名稱更新未完成/)
    assert.equal(harness.state.importing, false)
})
