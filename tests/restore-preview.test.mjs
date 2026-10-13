import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { renderToStaticMarkup } from 'react-dom/server'
import { compile, read } from './helpers/compile.mjs'

const calc = compile(read('src/lib/calc.ts'))
const validation = compile(read('src/lib/investmentValidation.ts'), calc)
const integrity = compile(read('src/lib/ledgerIntegrity.ts'), calc)
const doc = (id, data) => ({ id, data })
const cash = (amount, type = 'in') => ({ date: '2026-09-01', type, amount })
const trade = (overrides = {}) => ({ date: '2026-09-01', type: 'buy', code: '2330', name: 'fixture', price: 100, shares: 100, fee: 0, tax: 0, total: 10000, ...overrides })
const backup = (invest = {}, kms = {}) => ({ format: 'symbiosis-full-backup', version: 2, uid: 'A', exportedAt: '2026-09-30T00:00:00Z', invest, kms })

function harness(current = {}) {
    const state = { uid: 'A', login: {}, reads: [], writes: [], batches: 0, onRead: () => {} }
    const captureUserSession = () => {
        const uid = state.uid, login = state.login
        const assertActive = () => { if (uid !== state.uid || login !== state.login) throw Error('登入帳號已變更') }
        return { uid, assertActive, col(db, col) { assertActive(); return `${db}/${col}` }, doc(db, col, id) { assertActive(); return `${db}/${col}/${id}` } }
    }
    const mod = compile(read('src/lib/backup.ts'), { ...calc, ...validation, ...integrity, captureUserSession,
        investDB: 'invest', kmsDB: 'kms', invalidateAllInvestData() {},
        getDocsFromServer: async path => {
            state.reads.push(path); await state.onRead(path)
            return { docs: (current[path] || []).map(row => ({ id: row.id, data: () => structuredClone(row.data) })) }
        },
        writeBatch: () => {
            state.batches++; const pending = []
            return { set: (path, data) => pending.push({ path, data }), commit: async () => { state.writes.push(...pending) } }
        },
    })
    return { ...mod, state, current, captureUserSession }
}

test('preview distinguishes additions, full replacements, equal content and retained rows without writing', async () => {
    const h = harness({ 'invest/watchlist': [doc('same', { a: 1, nested: { x: 1, y: 2 } }), doc('replace', { a: 1, obsolete: true }), doc('keep', { a: 9 })] })
    const preview = await h.previewFullRestore(backup({ watchlist: [doc('new', { a: 2 }), doc('same', { nested: { y: 2, x: 1 }, a: 1 }), doc('replace', { a: 1 })], ignoredCollection: [doc('ignored', {})] }))
    assert.deepEqual(preview.collections, [{ key: 'invest/watchlist', label: '選股追蹤', added: 1, overwritten: 1, unchanged: 1, retained: 1, skipped: 0, repeated: 0 }])
    assert.deepEqual(h.state.reads, ['invest/watchlist'])
    assert.equal(h.state.batches, 0)
    assert.deepEqual(h.state.writes, [])
})

test('nonfinancial invalid rows are shown as skipped and duplicate IDs use the last effective payload', async () => {
    const h = harness()
    const b = backup({ watchlist: [doc('duplicate', { price: 1 }), doc('duplicate', { price: 2 }), doc('a/b', {}), null] })
    const preview = await h.previewFullRestore(b)
    assert.equal(preview.collections[0].added, 1)
    assert.equal(preview.collections[0].skipped, 2)
    assert.equal(preview.collections[0].repeated, 1)
    const result = await h.restoreFullBackup(b, undefined, preview)
    assert.deepEqual(result, { written: 2, skipped: 2 })
    assert.equal(h.state.writes.at(-1).data.price, 2)
})

test('KMS and investment settings remain separate and legacy body reconstruction matches the restore', async () => {
    const h = harness({ 'invest/settings': [doc('theme', { name: 'old' })], 'kms/settings': [doc('tagOrder', { order: [] })],
        'kms/noteBodies': [doc('n', { content: 'newer', assets: [] })] })
    const b = backup({ settings: [doc('theme', { name: 'new' })] }, { settings: [doc('tagOrder', { order: [] })], notes: [doc('n', { title: 'legacy', content: 'older', assets: [] })] })
    const preview = await h.previewFullRestore(b)
    assert.equal(preview.collections.find(row => row.key === 'invest/settings').overwritten, 1)
    assert.equal(preview.collections.find(row => row.key === 'kms/settings').unchanged, 1)
    assert.equal(preview.collections.find(row => row.key === 'kms/noteBodies').overwritten, 1)
    await h.restoreFullBackup(b, undefined, preview)
    assert.deepEqual(h.state.writes.find(row => row.path === 'kms/noteBodies/n').data, { content: 'older', assets: [] })
    assert.equal(b.kms.noteBodies, undefined)
})

test('monetary totals include retained documents and preserve buy/sell and in/out direction', async () => {
    const h = harness({ 'invest/trades': [doc('buy', trade()), doc('sell', trade({ date: '2026-09-02', type: 'sell', shares: 10, total: 1000 }))],
        'invest/cashflow': [doc('in', cash(100000)), doc('out', cash(3000, 'out')), doc('keep', cash(2000))],
        'invest/dividends': [doc('div', { date: '2026-09-01', code: '2330', name: 'fixture', cashDividend: 200, stockDividend: 0 })] })
    const preview = await h.previewFullRestore(backup({ trades: [doc('buy', trade({ shares: 200, total: 20000 }))],
        cashflow: [doc('in', cash(90000)), doc('new-out', cash(1000, 'out'))],
        dividends: [doc('div', { date: '2026-09-01', code: '2330', name: 'fixture', cashDividend: 300, stockDividend: 0 })] }))
    assert.deepEqual(preview.amounts.map(row => [row.label, row.before, row.after]), [
        ['買入付款合計', 10000, 20000], ['賣出收款合計', 1000, 1000], ['入金合計', 102000, 92000], ['出金合計', 3000, 4000], ['現金股利紀錄合計', 200, 300],
    ])
    assert.equal(h.state.reads.filter(path => path === 'invest/trades').length, 1)
    assert.equal(h.state.reads.filter(path => path === 'invest/dividends').length, 1)
})

test('snapshot preview compares the latest date, never sums historical assets', async () => {
    const snapshot = (date, totalAssets) => ({ date, totalAssets, marketValue: 0, cash: totalAssets })
    const h = harness({ 'invest/assetSnapshots': [doc('older', snapshot('2026-08-01', 1000000)), doc('latest', snapshot('2026-09-01', -10))] })
    const preview = await h.previewFullRestore(backup({ assetSnapshots: [doc('older', snapshot('2026-08-01', 2000000)), doc('new', snapshot('2026-09-02', 100))] }))
    assert.deepEqual(preview.amounts, [{ label: '最新快照總資產', before: -10, after: 100, beforeDate: '2026-09-01', afterDate: '2026-09-02' }])
})

test('invalid existing amounts are disclosed instead of silently counted as zero', async () => {
    const h = harness({ 'invest/cashflow': [doc('invalid', cash('bad')), doc('bad-type', cash(100, 'invalid'))] })
    const preview = await h.previewFullRestore(backup({ cashflow: [doc('new', cash(200))] }))
    assert.ok(preview.amounts.every(row => row.before === null && row.after === null))
})

for (const invest of [{ cashflow: [doc('bad', cash(-100))] }, { trades: [doc('sell', trade({ type: 'sell' }))] }]) {
    test(`preview blocks invalid ${Object.keys(invest)[0]} without any writes`, async () => {
        const h = harness()
        await assert.rejects(h.previewFullRestore(backup(invest)))
        assert.equal(h.state.batches, 0)
        assert.deepEqual(h.state.writes, [])
    })
}

test('preview checks the merged ledger with retained sells and reads the missing dividend collection', async () => {
    const h = harness({ 'invest/trades': [doc('buy', trade()), doc('sell', trade({ type: 'sell', date: '2026-09-02' }))] })
    await assert.rejects(h.previewFullRestore(backup({ trades: [doc('buy', trade({ shares: 50, total: 5000 }))] })), /缺少 50 股/)
    assert.ok(h.state.reads.includes('invest/dividends'))
    assert.equal(h.state.batches, 0)
})

for (const fail of ['offline', 'account']) test(`preview ${fail} failure never produces a writable preview`, async () => {
    const h = harness()
    h.state.onRead = async () => { if (fail === 'offline') throw Error('offline'); h.state.uid = 'B' }
    await assert.rejects(h.previewFullRestore(backup({ watchlist: [doc('w', {})] })), /offline|帳號已變更/)
    assert.equal(h.state.batches, 0)
})

for (const change of ['edit', 'add', 'delete', 'retained']) test(`confirmation rejects ${change} after preview before creating a write batch`, async () => {
    const h = harness({ 'invest/cashflow': [doc('a', cash(100)), doc('keep', cash(200))] })
    const b = backup({ cashflow: [doc('a', cash(300))] }), preview = await h.previewFullRestore(b)
    if (change === 'edit') h.current['invest/cashflow'][0].data.amount = 500
    if (change === 'add') h.current['invest/cashflow'].push(doc('new', cash(1000)))
    if (change === 'delete') h.current['invest/cashflow'].shift()
    if (change === 'retained') h.current['invest/cashflow'][1].data.amount = 300
    await assert.rejects(h.restoreFullBackup(b, undefined, preview), /還原前檢查.*雲端資料已變更/)
    assert.equal(h.state.batches, 0)
})

test('confirming altered backup or fabricated preview fails before writes', async () => {
    const h = harness(), b = backup({ watchlist: [doc('w', {})] })
    const preview = await h.previewFullRestore(b)
    b.invest.watchlist[0].data.name = 'changed'
    await assert.rejects(h.restoreFullBackup(b, undefined, preview), /備份已變更/)
    await assert.rejects(h.restoreFullBackup(b, undefined, { ...preview }), /預覽已失效/)
    assert.equal(h.state.batches, 0)
})

test('switching away or replacing the same-UID login invalidates the captured preview session', async () => {
    for (const replaceSameUid of [false, true]) {
        const h = harness(), b = backup({ watchlist: [doc('w', {})] }), preview = await h.previewFullRestore(b)
        if (replaceSameUid) h.state.login = {}; else h.state.uid = 'B'
        await assert.rejects(h.restoreFullBackup(b, undefined, preview), /還原前檢查.*帳號已變更/)
        assert.equal(h.state.batches, 0)
    }
})

test('confirmation read failure prevents all writes; server row/key order changes are harmless', async () => {
    const h = harness({ 'invest/watchlist': [doc('a', { name: 'A', nested: { x: 1, y: 2 } }), doc('b', {})] })
    const b = backup({ watchlist: [doc('a', { name: 'updated' })] }), preview = await h.previewFullRestore(b)
    h.state.onRead = async () => { throw Error('offline') }
    await assert.rejects(h.restoreFullBackup(b, undefined, preview), /尚未寫入.*offline/)
    assert.equal(h.state.batches, 0)
    h.state.onRead = () => {}
    h.current['invest/watchlist'].reverse()
    h.current['invest/watchlist'][1].data = { nested: { y: 2, x: 1 }, name: 'A' }
    await h.restoreFullBackup(b, undefined, preview)
    assert.deepEqual(h.state.writes, [{ path: 'invest/watchlist/a', data: { name: 'updated' } }])
})

const settingsSource = read('src/pages/invest/InvestSettings.tsx')
function picker(h) {
    const state = { preview: { old: true }, reading: false, message: '', mismatch: false, restoring: false }
    const request = { current: 0 }
    const handlers = settingsSource.slice(settingsSource.indexOf('    const handlePickRestoreFile ='), settingsSource.indexOf('    const handleCancelRestore ='))
    const bind = extra => compile(handlers, { ...h, restoreRequest: request, importLock: { current: false }, restoring: false, restoreReading: false,
        restorePreview: state.preview, setRestorePreview: value => { state.preview = value }, setRestoreReading: value => { state.reading = value },
        setRestoreUidMismatch: value => { state.mismatch = value }, setRestoreProgress() {}, setRestoring: value => { state.restoring = value },
        showMsg: value => { state.message = value }, invalidateAllInvestData() {}, invalidateAllKmsData() {}, cache: { clear() {} },
        console: { error() {} }, ...extra }, 'export { handlePickRestoreFile, handleConfirmRestore }')
    const choose = async (fileText = JSON.stringify(backup({ watchlist: [doc('w', {})] })), beforeRead = () => {}) => {
        const input = { value: 'same.json', files: [{ text: async () => { beforeRead(); return fileText } }] }
        await bind().handlePickRestoreFile({ target: input }); return input
    }
    return { state, request, choose, confirm: () => bind().handleConfirmRestore() }
}

test('file read account switch prevents later preview reads and clears the previous preview', async () => {
    const h = harness(), ui = picker(h)
    const input = await ui.choose(undefined, () => { h.state.uid = 'B' })
    assert.equal(input.value, '')
    assert.equal(ui.state.reading, false)
    assert.equal(ui.state.preview, null)
    assert.match(ui.state.message, /尚未寫入.*帳號已變更/)
    assert.deepEqual(h.state.reads, [])
})

test('preview read failure cannot leave an older backup available for confirmation', async () => {
    const h = harness(), ui = picker(h)
    h.state.onRead = async () => { throw Error('offline') }
    const input = await ui.choose()
    assert.equal(input.value, '')
    assert.equal(ui.state.preview, null)
    assert.equal(ui.state.reading, false)
    assert.match(ui.state.message, /差異預覽失敗.*offline/)
})

test('UI passes the exact preview to restore and clears a stale preview on rejection', async () => {
    const h = harness(), ui = picker(h)
    await ui.choose(JSON.stringify(backup({ cashflow: [doc('new', cash(100))] })))
    h.current['invest/cashflow'] = [doc('remote', cash(200))]
    await ui.confirm()
    assert.equal(ui.state.preview, null)
    assert.equal(ui.state.restoring, false)
    assert.match(ui.state.message, /尚未寫入.*雲端資料已變更/)
    assert.equal(h.state.batches, 0)
})

test('cancelled/unmounted preview request cannot populate the UI after its read completes', async () => {
    const h = harness(), ui = picker(h)
    h.state.onRead = async () => { ui.request.current++ }
    await ui.choose()
    assert.equal(ui.state.preview, null)
})

const require = createRequire(import.meta.url)
const { default: Difference } = compile(read('src/components/RestoreDifferencePreview.tsx'), { require })
test('preview UI explains complete overwrite and amount scope without rendering saved settings', async () => {
    const h = harness({ 'invest/settings': [doc('googleCalendarAuth', { refreshToken: 'private-test-token' })], 'invest/cashflow': [doc('in', cash(200))] })
    const preview = await h.previewFullRestore(backup({ settings: [doc('googleCalendarAuth', { refreshToken: 'new-private-token' })], cashflow: [doc('in', cash(300))] }))
    const html = renderToStaticMarkup(Difference({ preview }))
    assert.match(html, /還原差異預覽/)
    assert.match(html, /新增 0 · 覆蓋 2 · 相同 0/)
    assert.match(html, /差額 \+100 元/)
    assert.match(html, /完整內容/)
    assert.match(html, /目前餘額/)
    assert.doesNotMatch(html, /private.*token/)
})
