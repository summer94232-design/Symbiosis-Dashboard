import test from 'node:test'
import assert from 'node:assert/strict'
import { compile, read } from './helpers/compile.mjs'

const timing = compile(read('src/lib/calendarTiming.ts'))
const dates = compile(read('src/lib/date.ts'))
const calendar = compile(read('src/lib/calendarData.ts'))
const session = { assertActive() {}, col: () => 'calendarEvents' }
const calc = compile(read('src/lib/calc.ts'))
const validation = compile(read('src/lib/investmentValidation.ts'), calc)
const ongoing = { id: 'ongoing', title: '跨日科技活動', type: 'tech', date: '2026-09-09', start: { date: '2026-09-09' }, end: { date: '2026-09-12' } }

// Execute the actual page loader, replacing only I/O and state publication.
test('daily brief retains event type and includes ongoing multi-day events', async () => {
    const source = read('src/pages/calendar/DailyBrief.tsx')
    const loader = source.slice(source.indexOf('const loadData = async'), source.indexOf('void loadData()'))
    let todayEvents
    const mod = compile(loader, {
        ...timing, ...dates, ...calendar, active: true, todayStr: '2026-09-10', captureUserSession: () => session,
        fetchCalendarEvents: async () => [ongoing, { ...ongoing, id: 'single', date: '2026-09-10', start: undefined, end: undefined }],
        fetchTasks: async () => [], setDataError: error => assert.equal(error, ''), setDataLoading() {},
        setTodayEvents: rows => { todayEvents = rows }, setUpcomingEvents() {}, setTodayTasks() {}, setOverdueTasks() {},
    }, 'export { loadData }')
    await mod.loadData()
    assert.ok(todayEvents.some(event => event.id === 'ongoing'))
    assert.equal(todayEvents.find(event => event.id === 'single').type, 'tech')
})

test('dashboard includes ongoing events but excludes events ending at today midnight', async () => {
    const source = read('src/pages/invest/Dashboard.tsx')
    const loader = source.slice(source.indexOf('const loadSideCards = async'), source.indexOf('// ✅ 修正：委託 PriceContext'))
    let events
    const mod = compile(loader, {
        ...timing, toLocalDateString: () => '2026-09-10', setSideLoading() {}, setTasks() {},
        fetchCalendarEvents: async () => [ongoing, { ...ongoing, id: 'ended', end: { dateTime: '2026-09-10T00:00:00+08:00' } }],
        fetchTasks: async () => [], setUpcomingEvents: rows => { events = rows },
    }, 'export { loadSideCards }')
    await mod.loadSideCards()
    assert.deepEqual(events.map(event => event.id), ['ongoing'])
})

function reconcileHarness(locals = []) {
    return compile(read('src/lib/googleCalendar.ts').replaceAll('import.meta.env.VITE_GOOGLE_CLIENT_ID', "'fixture'"), {
        investDB: 'db', captureUserSession: () => session,
        getDocsFromServer: async () => ({ docs: locals.map(row => ({ id: row.id, data: () => row })) }),
    }, 'export { reconcileATypeEvents }')
}
const remote = { sourceId: null, googleEventId: 'google', date: '2026-09-10', title: 'Google personal', description: '', updated: '2026-09-10T10:00:00Z', cancelled: false }
test('Google personal import respects the disabled personal sync type', async () => {
    const mod = reconcileHarness()
    assert.equal((await mod.reconcileATypeEvents(['tech'], [remote])).firestoreCreates.length, 0)
    assert.equal((await mod.reconcileATypeEvents(['personal'], [remote])).firestoreCreates.length, 1)
})
test('Google events already linked to excluded local types are not imported twice', async () => {
    const mod = reconcileHarness([{ ...ongoing, googleEventId: 'google' }])
    const result = await mod.reconcileATypeEvents(['personal'], [remote])
    assert.equal(result.firestoreCreates.length, 0)
    assert.equal(result.pushList.length, 0)
})

test('editing a linked calendar event marks a pending local change despite clock skew', async () => {
    const source = read('src/pages/calendar/CalendarHome.tsx')
    const loader = source.slice(source.indexOf('const handleUpdateEvent = async'), source.indexOf('// 全域資料不刪除'))
    const editingEvent = { ...ongoing, googleEventId: 'google', updatedAt: '2026-09-01T00:00:00Z' }
    let patch
    const mod = compile(loader, {
        ...timing, timing: timing.timingDraft(editingEvent), editingEvent,
        form: { title: 'local edit', date: ongoing.date, type: 'tech', description: '', url: '' }, investDB: 'db',
        mutation: { run: fn => fn({ ...session, doc: () => 'ref' }) },
        runTransaction: async (_, fn) => fn({ get: async () => ({ exists: () => true, data: () => editingEvent }), update: (_, data) => { patch = data } }),
        invalidateCalendarEvents() {}, setEditingEvent() {}, setTiming() {}, setForm() {}, loadPersonal: async () => {},
    }, 'export { handleUpdateEvent }')
    await mod.handleUpdateEvent()
    assert.equal(patch.googlePendingLocalChange, true)
    const result = await reconcileHarness([{ ...editingEvent, ...patch, updatedAt: '2026-09-01T01:00:00Z' }]).reconcileATypeEvents(['tech'], [remote])
    assert.equal(result.firestoreUpdates.length, 0)
    assert.equal(result.pushList[0].title, 'local edit')
})

test('TWR rejects numerically identical same-second sequence values', () => {
    const { calculateExactTwr } = compile(read('src/lib/exactTwr.ts'))
    const report = { startDate: '2026-01-01', endDate: '2026-01-31', startValue: '100', endValue: '250', startSource: 'statement', endSource: 'statement', ledgerSignature: '', valuations: {
        a: { time: '10:00:00', before: '110', source: 'statement', order: '1' },
        b: { time: '10:00:00', before: '220', source: 'statement', order: '01' },
    } }
    const flows = [{ id: 'a', date: '2026-01-15', type: 'in', amount: 100 }, { id: 'b', date: '2026-01-15', type: 'out', amount: 10 }]
    assert.equal(calculateExactTwr(report, flows).percent, null)
    assert.equal(calculateExactTwr(report, [...flows].reverse()).percent, null)
})

for (const scenario of [
    { name: 'announced stock dividends cannot cover a sale', status: 'announced', distribution: '2026-09-05', oversell: true },
    { name: 'stock dividends are unavailable before distribution', status: 'confirmed', distribution: '2026-09-11', oversell: true },
    { name: 'stock dividends are available on the explicit distribution date', status: 'confirmed', distribution: '2026-09-10', oversell: false },
]) test('data health agrees with holdings: ' + scenario.name, () => {
    const { analyzeDataHealth } = compile(read('src/lib/dataHealth.ts'), calc)
    const buy = { id: 'buy', date: '2026-09-01', code: '2330', name: '台積電', type: 'buy', shares: 100, price: 100, fee: 0, tax: 0, total: 10000 }
    const sell = { ...buy, id: 'sell', date: '2026-09-10', type: 'sell', shares: 110, total: 11000 }
    const dividends = [{ id: 'div', date: scenario.oversell ? '2026-09-05' : '2026-09-10', code: '2330', name: '台積電', cashDividend: 0, stockDividend: 10, status: scenario.status, stockDistributionDate: scenario.distribution }]
    const available = calc.calcSharesBeforeTrade(sell, [buy, sell], dividends)
    const report = analyzeDataHealth({ trades: [buy, sell], dividends, cashflow: [], snapshots: [], notes: [], trash: [], now: new Date('2026-09-11T00:00:00+08:00') })
    assert.equal(available < sell.shares, scenario.oversell)
    assert.equal(report.issues.some(issue => issue.id === 'oversell'), scenario.oversell)
})

const buy = { id: 'buy', date: '2026-09-01', code: '2330', name: '台積電', type: 'buy', price: 100, shares: 1000, fee: 0, tax: 0, total: 100000 }
const sell = { ...buy, id: 'sell', date: '2026-09-02', type: 'sell', price: 110, total: 110000 }
const integrity = compile(read('src/lib/ledgerIntegrity.ts'), calc)
test('historical buy reduction/deletion is blocked, while a price correction and incomplete-ledger repair remain valid', () => {
    const before = { trades: [buy, sell], dividends: [] }
    assert.throws(() => integrity.assertNoNewOversells(before, { ...before, trades: [{ ...buy, shares: 500 }, sell] }), /缺少 500 股/)
    assert.throws(() => integrity.assertNoNewOversells(before, { ...before, trades: [sell] }), /缺少 1000 股/)
    assert.doesNotThrow(() => integrity.assertNoNewOversells(before, { ...before, trades: [{ ...buy, price: 101 }, sell] }))
    assert.doesNotThrow(() => integrity.assertNoNewOversells({ ...before, trades: [sell] }, before))
})
test('stock dividend deletion, reduction, postponement or reverting to announced cannot invalidate later sales', () => {
    const dividend = { id: 'div', code: '2330', date: '2026-09-01', stockDistributionDate: '2026-09-02', status: 'confirmed', stockDividend: 100, cashDividend: 0 }
    const before = { trades: [buy, { ...sell, shares: 1100 }], dividends: [dividend] }
    for (const dividends of [[], [{ ...dividend, stockDividend: 50 }], [{ ...dividend, stockDistributionDate: '2026-09-03' }], [{ ...dividend, status: 'announced' }]]) {
        assert.throws(() => integrity.assertNoNewOversells(before, { ...before, dividends }), /缺少/)
    }
    assert.doesNotThrow(() => integrity.assertNoNewOversells(before, { ...before, dividends: [{ ...dividend, cashDividend: 100 }] }))
})
test('ledger validation reads current server data and refuses offline or changed-account results', async () => {
    for (const mode of ['normal', 'offline', 'switched']) {
        const seen = []
        const mod = compile(read('src/lib/ledgerIntegrity.ts'), { ...calc, investDB: 'db',
            captureUserSession: () => ({ col: (_, name) => name, assertActive() { if (mode === 'switched') throw Error('switched') } }),
            getDocsFromServer: async name => { seen.push(name); if (mode === 'offline') throw Error('offline'); return { docs: (name === 'trades' ? [buy, sell] : []).map(row => ({ id: row.id, data: () => row })) } },
        })
        await assert.rejects(mod.validateLedgerChange({ collection: 'trades', id: buy.id, data: { ...buy, shares: 500 } }), mode === 'normal' ? /缺少/ : new RegExp(mode))
        assert.deepEqual(seen, ['trades', 'dividends'])
    }
})
test('actual historical trade save keeps the form and performs no write when the edited buy invalidates a later sell', async () => {
    const source = read('src/pages/invest/Trades.tsx')
    const loader = source.slice(source.indexOf('const handleSave = async'), source.indexOf('const handleEdit ='))
    const notices = []
    const mod = compile(loader, {
        ...calc, ...validation, trades: [buy, sell], form: { ...buy, shares: 500, total: 50000 }, editingId: buy.id,
        missingRequiredFields: [], oversellWarning: null, duplicateTrade: null,
        captureUserSession: () => session,
        saveLock: { current: false }, pendingTradeId: { current: null },
        commitLedgerWrites: async ([change]) => integrity.assertNoNewOversells({ trades: [buy, sell], dividends: [] }, { trades: [change.data, sell], dividends: [] }),
        setSaveAttempted() {}, setLoading() {}, console: { error() {} }, showNotice: notice => notices.push(notice),
        saveStockName: () => assert.fail('must stop before writes'), updateDoc: () => assert.fail('must not save'),
        setForm: () => assert.fail('must retain form'),
    }, 'export { handleSave }')
    await mod.handleSave()
    assert.equal(notices.at(-1).type, 'error')
    assert.match(notices.at(-1).message, /缺少 500 股/)
})

test('trade delete, dividend edit/delete and calendar dividend delete all enforce ledger preflight before writing', async () => {
    const cases = [
        ['src/pages/invest/Trades.tsx', 'const handleDelete = async', 'const marginRepaymentEstimate', 'handleDelete', 'buy'],
        ['src/pages/invest/Dividend.tsx', 'const handleSave = async', 'const handleEdit =', 'handleSave'],
        ['src/pages/invest/Dividend.tsx', 'const handleDelete = async', 'const today =', 'handleDelete', 'div'],
        ['src/pages/calendar/CalendarHome.tsx', 'const handleDeleteDividend = async', 'const prevMonth =', 'handleDeleteDividend', { stockCode: '2330', date: '2026-09-01', title: '配股' }],
    ]
    for (const [path, start, end, name, argument] of cases) {
        let checked = false
        const source = read(path), errors = []
        const mod = compile(source.slice(source.indexOf(start), source.indexOf(end)), {
            trades: [buy, sell], records: [{ id: 'div', date: '2026-09-01', code: '2330' }], form: {}, editingId: 'div', confirmAction: async () => true, console: { error() {} },
            feedback: { clear() {} },
            captureUserSession: () => session, mutation: { run: fn => fn(session) }, setFormError() {},
            validateDividendForWrite: () => ({ valid: true }),
            commitLedgerWrites: async () => { checked = true; throw Error('ledger blocked') },
            fetchDividends: async () => [{ id: 'div', code: '2330', date: '2026-09-01' }],
            showNotice: notice => errors.push(notice.message), deleteDoc: () => assert.fail('must not delete'),
            writeBatch: () => assert.fail('must not start writes'),
        }, `export { ${name} }`)
        try { await mod[name](argument) } catch (error) { errors.push(error.message) }
        assert.equal(checked, true, path + ' ' + name)
        assert.deepEqual(errors, ['ledger blocked'])
    }
})
