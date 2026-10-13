// Read-only audit reproductions. These assertions confirm defects, not correct behavior.
// Run from the repository root: node docs/audit-2026-10-01/reproduce.mjs
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { initializeApp, deleteApp } from 'firebase/app'
import { getFirestore, writeBatch as sdkBatch, doc as sdkDoc } from 'firebase/firestore'
import { compile, read } from '../../tests/helpers/compile.mjs'

const evidence = []
const record = (id, details) => { evidence.push({ id, ...details }); console.log(id, JSON.stringify(details)) }
const calc = compile(read('src/lib/calc.ts'))
const validation = compile(read('src/lib/investmentValidation.ts'), calc)
const csv = compile(read('src/lib/csv.ts'))
const dayCsv = compile(read('src/lib/dayTradeCsv.ts'), calc)
const search = compile(read('src/lib/kmsSearch.ts'))
const app = initializeApp({ projectId: 'audit-offline-no-network' }, 'audit-offline-no-network')
const db = getFirestore(app)
const kmsSource = read('src/pages/kms/KMSHome.tsx')
const kmsHandler = kmsSource.slice(kmsSource.indexOf('    const handleImportNotes ='), kmsSource.indexOf('    const handleSort ='))

function kmsHarness({ text, fileName = 'notes.json', switchAt = '', lostAck = false }) {
  const state = { uid: 'A', writes: [], messages: [], serial: 0, commits: 0, lose: lostAck }
  const mod = compile(kmsHandler, {
    ...csv, ...search, kmsDB: 'kms',
    userCol: (_, name) => `users/${state.uid}/${name}`,
    userDoc: (_, name, id) => ({ id, path: `users/${state.uid}/${name}/${id}` }),
    doc: path => { const id = `import-${++state.serial}`; return { id, path: `${path}/${id}` } },
    writeBatch: () => {
      const rows = [], validator = sdkBatch(db)
      return {
        set: (ref, data) => { validator.set(sdkDoc(db, ref.path), data); rows.push({ path: ref.path, data }) },
        commit: async () => {
          state.writes.push(...structuredClone(rows)); state.commits++
          if (switchAt === 'first-commit' && state.commits === 1) state.uid = 'B'
          if (state.lose) { state.lose = false; throw Error('lost acknowledgement') }
        },
      }
    },
    setImporting() {}, setImportMsg: value => state.messages.push(value),
    invalidateKmsNotes() {}, onNotesChanged() {}, load() {},
  }, 'export { handleImportNotes }')
  return { state, run: () => mod.handleImportNotes({ target: { value: 'fixture', files: [{
    name: fileName, text: async () => { if (switchAt === 'file-read') state.uid = 'B'; return text },
  }] } }) }
}

try {
  const noUrl = kmsHarness({ text: JSON.stringify([{ title: '文字筆記', content: '正文' }]) })
  await noUrl.run()
  assert.equal(noUrl.state.writes.length, 0)
  assert.match(noUrl.state.messages.at(-1), /成功 0 筆，略過 1 筆/)
  record('R01', { trigger: 'ordinary note without URL', result: noUrl.state.messages.at(-1), writes: 0 })

  const notes = JSON.stringify([{ title: '第一則', content: 'A 的資料', url: 'https://example.com/1' },
    { title: '第二則', content: 'A 的資料', url: 'https://example.com/2' }])
  for (const switchAt of ['file-read', 'first-commit']) {
    const h = kmsHarness({ text: notes, switchAt }); await h.run()
    const paths = h.state.writes.filter(row => row.path.includes('/notes/')).map(row => row.path)
    assert.ok(paths.some(path => path.startsWith('users/B/')))
    record('R02', { switchAt, paths, result: h.state.messages.at(-1) })
  }

  const multiline = kmsHarness({ fileName: 'notes.csv',
    text: 'title,url,content\n"跨行筆記","https://example.com/","第一行\n第二行"' })
  await multiline.run()
  const body = multiline.state.writes.find(row => row.path.includes('/noteBodies/'))
  assert.equal(body.data.content, '第一行')
  record('R03', { expectedContent: '第一行\n第二行', actualContent: body.data.content,
    result: multiline.state.messages.at(-1) })

  const lost = kmsHarness({ text: notes, lostAck: true }); await lost.run()
  const firstMessage = lost.state.messages.at(-1); await lost.run()
  assert.equal(lost.state.writes.filter(row => row.path.includes('/notes/')).length, 4)
  record('R04', { trigger: 'first commit succeeds but acknowledgement is lost; retry same file',
    firstMessage, noteCountAfterRetry: 4, expectedUniqueNotes: 2 })

  const tradeSource = read('src/pages/invest/Trades.tsx')
  const tradeImport = tradeSource.slice(tradeSource.indexOf('    const handleImportCSV ='), tradeSource.indexOf('    const dayTradeAnalysis ='))
  async function importTrade(text) {
    const state = { writes: [], result: null }, session = { assertActive() {},
      col: (_, name) => name, doc: (_, name, id) => `${name}/${id}` }
    const h = compile(tradeImport, {
      ...calc, ...validation, ...csv, ...dayCsv, investDB: 'invest', dividends: [],
      captureUserSession: () => session, getDocs: async () => ({ docs: [] }),
      addDoc: async (path, data) => { state.writes.push({ path, data }); return { id: 'new' } },
      setDoc: async (path, data) => state.writes.push({ path, data }), saveStockName: async () => {},
      resolveMarginInterestRate: () => 0.0625, marginRules: {},
      invalidateTrades() {}, invalidateCashflow() {}, setImporting() {}, load() {},
      setImportResult: value => { state.result = value },
    }, 'export { handleImportCSV }')
    await h.handleImportCSV({ target: { value: 'fixture', files: [{ text: async () => text }] } })
    return state
  }
  const rejected = await importTrade('日期,類型,代號,名稱,價格,股數,手續費,交易稅,收付金額\n2026-09-01,買入,2330,測試,100,1000,50,0,100050')
  assert.equal(rejected.result.failed, 1); assert.equal(rejected.writes.length, 0)
  const changed = await importTrade('日期,類型,代號,名稱,價格,股數,手續費,交易稅\n2026-09-01,買入,2330,測試,100,1000,50,0')
  assert.equal(changed.writes[0].data.fee, 85)
  record('R05', { trigger: 'trade-page CSV import with actual brokerage fee 50',
    withTotal: rejected.result, withoutTotal: { fee: changed.writes[0].data.fee, total: changed.writes[0].data.total } })

  const buy1 = { id: 'buy1', date: '2026-09-01', code: '2330', name: '測試', type: 'buy', price: 100, shares: 1000, fee: 0, tax: 0, total: 100000 }
  const buy2 = { ...buy1, id: 'buy2', date: '2026-09-02', price: 200, total: 200000 }
  const sell = { ...buy1, id: 'sell', date: '2026-09-03', type: 'sell', price: 300, total: 300000,
    inventoryMatches: [{ buyId: 'buy2', shares: 1000 }] }
  const rebuilt = { ...sell, inventoryMatches: undefined, ...dayCsv.importDayTradeFields(dayCsv.exportDayTradeFields(sell)) }
  const before = calc.calcPositions([buy1, buy2, sell], []).realized
  const after = calc.calcPositions([buy1, buy2, rebuilt], []).realized
  assert.notDeepEqual(before, after)
  record('R06', { trigger: 'CSV export/import omits designated inventory matches',
    originalRealized: before.map(row => row.realized), restoredRealized: after.map(row => row.realized) })

  const local = { id: 'local', date: '2026-10-02', type: 'personal', title: '尚未同步的修改',
    googleEventId: 'google-event', updatedAt: '2026-10-01T10:00:00Z', googlePendingLocalChange: true }
  const g = compile(read('src/lib/googleCalendar.ts'), {
    investDB: 'invest', captureUserSession: () => ({ assertActive() {}, col: () => 'events' }),
    getDocsFromServer: async () => ({ docs: [{ id: local.id, data: () => local }] }),
  }, 'export { reconcileATypeEvents }')
  const reconciliation = await g.reconcileATypeEvents(['personal'], [{ googleEventId: 'google-event',
    sourceId: 'local', cancelled: true, updated: '2026-10-01T01:00:00Z' }])
  assert.deepEqual(reconciliation.firestoreDeletes, ['local'])
  assert.deepEqual(reconciliation.warnings, [])
  record('R07', { trigger: 'remote cancellation conflicts with newer pending local edit',
    deletes: reconciliation.firestoreDeletes, warnings: reconciliation.warnings })

  const save = tradeSource.slice(tradeSource.indexOf('    const handleSave ='), tradeSource.indexOf('    const handleEdit ='))
  const server = [buy1]
  let serverPreflights = 0
  for (const date of ['2026-09-03', '2026-09-04']) {
    const form = { ...sell, id: undefined, inventoryMatches: undefined, date, shares: 600, price: 100, total: 60000 }
    const noOp = () => {}
    const h = compile(save, { ...calc, ...validation, form, trades: [buy1], dividends: [],
      editingId: null, missingRequiredFields: [], oversellWarning: null, duplicateTrade: null,
      investDB: 'invest', captureUserSession: () => ({ assertActive() {}, col: (_, name) => name }),
      validateLedgerChange: async () => { serverPreflights++ }, saveStockName: async () => {},
      addDoc: async (_, payload) => { server.push({ ...payload, id: `sell-${server.length}` }) },
      marginRules: { defaultInterestRate: 0.0625 }, emptyTrade: {}, lastTradeDate: '',
      requestAnimationFrame: noOp, newCodeInputRef: { current: null }, load: async () => {},
      showNotice: noOp, setLoading: noOp, invalidateTrades: noOp, setLastTradeDate: noOp,
      setEditingId: noOp, setForm: noOp, setShowForm: noOp, setEditModal: noOp,
      setSaveAttempted: noOp, setCodeSuggestions: noOp, setNameSuggestions: noOp,
      setShowCodeSuggestions: noOp, setShowNameSuggestions: noOp,
    }, 'export { handleSave }')
    await h.handleSave()
  }
  assert.equal(server.length, 3)
  assert.equal(serverPreflights, 0)
  const integrity = compile(read('src/lib/ledgerIntegrity.ts'), calc)
  assert.throws(() => integrity.assertNoNewOversells({ trades: [buy1], dividends: [] }, { trades: server, dividends: [] }), /缺少/)
  record('R08', { trigger: 'two stale views each sell 600 shares from the same 1000-share balance',
    persistedSoldShares: 1200, availableShares: 1000, serverPreflights })

  const bondTax = calc.calcTax(100, 1000, '00679B')
  assert.equal(bondTax, 100)
  record('R09', { trigger: 'passive bond ETF sale during the exemption period, e.g. 2026-10-01',
    code: '00679B', gross: 100000, actualEstimatedTax: bondTax, expectedTax: 0,
    officialSource: 'https://www.etax.nat.gov.tw/etwmain/tax-info/understanding/tax-q-and-a/national/securities-transaction-tax/taxation-scope/7r3MjNB' })
} finally {
  await deleteApp(app)
  writeFileSync('docs/audit-2026-10-01/evidence.json', JSON.stringify(evidence, null, 2) + '\n')
}
