import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { renderToStaticMarkup } from 'react-dom/server'
import * as XLSX from 'xlsx'
import { compile, read } from './helpers/compile.mjs'

const calc = compile(read('src/lib/calc.ts'))
const validation = compile(read('src/lib/investmentValidation.ts'), calc)
const csv = compile(read('src/lib/csv.ts'))
const dayCsv = compile(read('src/lib/dayTradeCsv.ts'), calc)
const repaymentCsv = compile(read('src/lib/marginRepayment.ts'), calc)
const source = read('src/pages/invest/InvestSettings.tsx')
const handlers = source.slice(source.indexOf('    const handleImportDict ='), source.indexOf('    // ── 一鍵匯出全部資料'))
const fixtures = {
    Dict: { col: 'stockDict', handler: 'handleImportDict', loading: 'importing', result: 'importResult', rows: [
        { 股票代號: '2330', 股票名稱: '測試甲' }, { 股票代號: '2317', 股票名稱: '測試乙' },
    ] },
    Trades: { col: 'trades', handler: 'handleImportTradesCSV', loading: 'tradeImporting', result: 'tradeImportResult', text: '日期,類型,代號,名稱,價格,股數,手續費,交易稅,收付金額\n2026-09-01,買入,2330,測試甲,100,100,0,0,10000\n2026-09-02,買入,2317,測試乙,100,100,0,0,10000' },
    Cash: { col: 'cashflow', handler: 'handleImportCashCSV', loading: 'cashImporting', result: 'cashImportResult', text: '日期,類型,金額\n2026-09-01,入金,100\n2026-09-02,出金,200' },
    Dividend: { col: 'dividends', handler: 'handleImportDividendCSV', loading: 'divImporting', result: 'divImportResult', text: '日期,代號,名稱,現金股利,股票股利\n2026-09-01,2330,測試甲,100,0\n2026-09-02,2317,測試乙,0,100' },
}
const exportNames = Object.values(fixtures).map(row => row.handler).join(', ')

function harness(kind, options = {}) {
    const fixture = fixtures[kind], investAuth = { currentUser: { uid: 'A' } }, kmsAuth = { currentUser: { uid: 'kms-A' } }
    const state = { writes: [], reads: [], events: [], cachedNames: [], invalidated: [], message: '', results: {}, loading: {} }
    const importLock = { current: false }, occurrences = {}
    const boundary = async (stage, path) => {
        state.events.push({ stage, path }); occurrences[stage] = (occurrences[stage] || 0) + 1
        const matches = option => option?.stage === stage && (option.occurrence || 1) === occurrences[stage]
        if (matches(options.switchAt)) {
            investAuth.currentUser = { uid: options.sameUid ? 'A' : 'B' }
            kmsAuth.currentUser = { uid: options.sameUid ? 'kms-A' : 'kms-B' }
        }
        if (options.beforeBoundary) await options.beforeBoundary(stage, state)
        if (matches(options.failAt)) throw Error('測試連線失敗')
    }
    const db = compile(read('src/lib/userDB.ts'), { investAuth, kmsAuth, collection: (_, ...parts) => parts.join('/'), doc: (_, ...parts) => parts.join('/') })
    const bindings = { ...calc, ...validation, ...csv, ...dayCsv, ...repaymentCsv, ...db, XLSX, importLock, restoring: options.restoring || false,
        investDB: 'invest', doc: () => ({ id: 'new-' + state.writes.length }),
        commitLedgerWrites: async (writes, session) => {
            for (const write of writes) await bindings.setDoc(session.doc('invest', write.collection, write.id), write.data)
        },
        showMsg: message => { state.message = message },
        cacheStockName: (code, name) => state.cachedNames.push({ uid: investAuth.currentUser.uid, code, name }),
        cache: { invalidatePrefix: prefix => state.invalidated.push(prefix) },
        invalidateTrades: () => state.invalidated.push('trades'), invalidateCashflow: () => state.invalidated.push('cashflow'), invalidateDividends: () => state.invalidated.push('dividends'),
        getDocs: async path => {
            state.reads.push(path); await boundary('query', path)
            const col = path.split('/').at(-1)
            return { docs: (options.current?.[col] || []).map(row => ({ id: row.id, data: () => row.data })) }
        },
        addDoc: async (path, data) => {
            const stage = 'primary', failed = options.failAt?.stage === stage && (options.failAt.occurrence || 1) === (occurrences[stage] || 0) + 1
            if (!failed || options.lostAck) state.writes.push({ path, data, id: `new-${state.writes.length}` })
            await boundary(stage, path)
            return { id: state.writes.at(-1).id }
        },
        setDoc: async (path, data) => {
            const stage = kind !== 'Dict' && path.includes('/stockDict/') ? 'dictionary' : 'primary'
            const failed = options.failAt?.stage === stage && (options.failAt.occurrence || 1) === (occurrences[stage] || 0) + 1
            if (!failed || options.lostAck) state.writes.push({ path, data })
            await boundary(stage, path)
        },
    }
    for (const f of Object.values(fixtures)) {
        const resultSetter = `set${f.result[0].toUpperCase()}${f.result.slice(1)}`
        const loadingSetter = `set${f.loading[0].toUpperCase()}${f.loading.slice(1)}`
        bindings[resultSetter] = value => { state.results[f.result] = value }
        bindings[loadingSetter] = value => { state.loading[f.loading] = value }
    }
    const mod = compile(handlers, bindings, `export { ${exportNames} };`)
    const makeInput = (selectedKind = kind) => ({ value: 'fixture', files: [{
        text: async () => { await boundary('file'); return options.text ?? fixtures[selectedKind].text },
        arrayBuffer: async () => {
            await boundary('file')
            const workbook = XLSX.utils.book_new()
            XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(options.rows || fixtures.Dict.rows), '字典')
            return XLSX.write(workbook, { type: 'array', bookType: 'xlsx' })
        },
    }] })
    const input = makeInput()
    return { state, importLock, mod, makeInput, input, run: () => mod[fixture.handler]({ target: input }),
        result: () => state.results[fixture.result], primary: () => state.writes.filter(row => row.path.split('/')[2] === fixture.col) }
}

for (const kind of Object.keys(fixtures)) {
    test(`${kind}: normal import confirms both rows and releases loading, lock and file input`, async () => {
        const h = harness(kind); await h.run()
        assert.equal(h.result().success, 2)
        assert.equal(h.result().failed, 0)
        assert.equal(h.result().error, undefined)
        assert.equal(h.primary().length, 2)
        assert.ok(h.state.writes.every(row => row.path.startsWith('users/A/')))
        assert.equal(h.importLock.current, false)
        assert.equal(h.state.loading[fixtures[kind].loading], false)
        assert.equal(h.input.value, '')
    })
    for (const stage of ['file', 'primary', ...(kind === 'Dict' ? [] : ['query']), ...(['Trades', 'Dividend'].includes(kind) ? ['dictionary'] : [])]) {
        test(`${kind}: account switch during ${stage} stops subsequent writes and preserves confirmed count`, async () => {
            const h = harness(kind, { switchAt: { stage } }); await h.run()
            assert.ok(h.state.writes.every(row => row.path.startsWith('users/A/')))
            assert.equal(h.primary().length, ['primary', 'dictionary'].includes(stage) ? 1 : 0)
            assert.equal(h.result().success, h.primary().length)
            assert.equal(h.result().failed, 0)
            assert.match(h.result().error, /登入帳號已變更/)
            assert.ok(h.state.cachedNames.every(row => row.uid === 'A'))
            assert.equal(h.importLock.current, false)
            assert.equal(h.state.loading[fixtures[kind].loading], false)
            assert.equal(h.input.value, '')
        })
    }
    for (const stage of ['file', ...(kind === 'Dict' ? [] : ['query'])]) {
        test(`${kind}: ${stage} failure resets loading and publishes a persistent error with no writes`, async () => {
            const h = harness(kind, { failAt: { stage } }); await h.run()
            assert.equal(h.primary().length, 0)
            assert.equal(h.result().success, 0)
            assert.match(h.result().error, /測試連線失敗/)
            assert.equal(h.input.value, '')
            assert.equal(h.importLock.current, false)
            assert.equal(h.state.loading[fixtures[kind].loading], false)
        })
    }
    test(`${kind}: second primary write failure preserves the first success and stops with uncertain write status`, async () => {
        const h = harness(kind, { failAt: { stage: 'primary', occurrence: 2 } }); await h.run()
        assert.equal(h.result().success, 1)
        assert.equal(h.result().failed, 1)
        assert.equal(h.primary().length, 1)
        assert.match(h.result().error, /寫入未確認/)
        assert.equal(h.importLock.current, false)
    })
    test(`${kind}: lost acknowledgement never claims the committed row was confirmed successful`, async () => {
        const h = harness(kind, { failAt: { stage: 'primary' }, lostAck: true }); await h.run()
        assert.equal(h.primary().length, 1)
        assert.equal(h.result().success, 0)
        assert.match(h.result().error, /寫入未確認/)
        assert.equal(h.state.events.filter(row => row.stage === 'primary').length, 1)
    })
    test(`${kind}: replacing a same-UID Auth object also invalidates the import`, async () => {
        const h = harness(kind, { switchAt: { stage: 'file' }, sameUid: true }); await h.run()
        assert.match(h.result().error, /登入帳號已變更/)
        assert.equal(h.primary().length, 0)
    })
}

for (const kind of ['Trades', 'Dividend']) test(`${kind}: dictionary failure counts a committed record once and stops before the second row`, async () => {
    const h = harness(kind, { failAt: { stage: 'dictionary' } }); await h.run()
    assert.equal(h.result().success, 1)
    assert.equal(h.result().failed, 0)
    assert.equal(h.primary().length, 1)
    assert.match(h.result().error, /已匯入.*股票名稱更新未完成/)
    assert.deepEqual(h.state.cachedNames, [])
})

for (const kind of ['Trades', 'Cash', 'Dividend']) test(`${kind}: duplicate and invalid rows remain counted without interrupting valid rows`, async () => {
    const lines = fixtures[kind].text.split('\n')
    const invalid = kind === 'Trades' ? '2026-02-30,買入,2330,測試甲,100,100,0,0,10000' : kind === 'Cash' ? '2026-02-30,入金,100' : '2026-02-30,2330,測試甲,100,0'
    const h = harness(kind, { text: [lines[0], lines[1], lines[1], invalid, lines[2]].join('\n') }); await h.run()
    assert.equal(h.result().success, 2)
    assert.equal(h.result().duplicated, 1)
    assert.equal(h.result().failed, 1)
    assert.equal(h.result().error, undefined)
})

test('dictionary: malformed codes and missing fields are skipped while valid names are cached only for the pinned account', async () => {
    const h = harness('Dict', { rows: [{ 股票代號: 'a/b', 股票名稱: '無效' }, { 股票代號: '2330' }, ...fixtures.Dict.rows] }); await h.run()
    assert.equal(h.result().success, 2)
    assert.equal(h.result().failed, 2)
    assert.equal(h.result().error, undefined)
    assert.ok(h.state.cachedNames.every(row => row.uid === 'A'))
})

test('trade CSV keeps explicit source IDs and merged ledger validation blocks a new oversell', async () => {
    const h = harness('Trades', { text: '日期,類型,代號,名稱,價格,股數,手續費,交易稅,收付金額,Firestore ID\n2026-09-01,買入,2330,測試甲,100,100,0,0,10000,source-buy\n2026-09-02,賣出,2330,測試甲,100,200,0,0,20000,source-sell' })
    await h.run()
    assert.equal(h.result().success, 1)
    assert.equal(h.result().failed, 1)
    assert.equal(h.primary()[0].path, 'users/A/trades/source-buy')
})

test('all four import handlers share a synchronous lock, released after the pending import finishes', async () => {
    let release, signal
    const started = new Promise(resolve => { signal = resolve })
    const gate = new Promise(resolve => { release = resolve })
    const h = harness('Dict', { beforeBoundary: async stage => { if (stage === 'file') { signal(); await gate } } })
    const running = h.run(); await started
    assert.equal(h.importLock.current, true)
    for (const f of Object.values(fixtures)) await h.mod[f.handler]({ target: h.makeInput() })
    assert.equal(h.state.events.filter(row => row.stage === 'file').length, 1)
    assert.equal(h.state.reads.length, 0)
    release(); await running
    assert.equal(h.importLock.current, false)
})

test('imports cannot start during a JSON restore', async () => {
    const h = harness('Cash', { restoring: true }); await h.run()
    assert.deepEqual(h.state.events, [])
    assert.equal(h.importLock.current, false)
})

const require = createRequire(import.meta.url)
const { default: Notice } = compile(read('src/components/ImportFailureNotice.tsx'), { require })
test('failure notice persists beside confirmed counts and is absent on successful imports', () => {
    assert.equal(renderToStaticMarkup(Notice({ success: 2 })), '')
    const html = renderToStaticMarkup(Notice({ success: 1, error: '測試連線失敗' }))
    assert.match(html, /role="alert"/)
    assert.match(html, /匯入已中止：測試連線失敗/)
    assert.match(html, /已確認成功 1 筆/)
    assert.match(html, /已成功資料仍保留/)
})
