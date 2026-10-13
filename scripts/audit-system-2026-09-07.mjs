// Read-only audit reproductions. All I/O dependencies are mocked; no live services.
// These assertions confirm CURRENT DEFECTS, not successful product behavior.
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import ts from 'typescript'
import { initializeApp, deleteApp } from 'firebase/app'
import { getFirestore, doc, writeBatch } from 'firebase/firestore'
import { execFileSync } from 'node:child_process'

const read = path => readFileSync(path, 'utf8')
const observations = []
function compile(source, bindings = {}, extra = '') {
  const ast = ts.createSourceFile('audit.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  for (const node of [...ast.statements].reverse()) {
    if (ts.isImportDeclaration(node)) source = source.slice(0, node.pos) + source.slice(node.end)
  }
  const output = ts.transpileModule(source + '\n' + extra, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText
  const exports = {}
  new Function('exports', ...Object.keys(bindings), output)(exports, ...Object.values(bindings))
  return exports
}
function callback(path, name, bindings) {
  const source = read(path)
  const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  let expression
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === name) {
      expression = ts.isCallExpression(node.initializer) ? node.initializer.arguments[0] : node.initializer
    }
    ts.forEachChild(node, visit)
  }
  visit(ast)
  assert.ok(expression, name)
  return compile(`export const run = ${expression.getText(ast)}`, bindings).run
}
function record(id, actual, expected) { observations.push({ id, actual, expected }) }
const calc = compile(read('src/lib/calc.ts'))
const trade = overrides => ({ id: 't', date: '2026-01-02', type: 'buy', code: '2330', name: 'fixture', price: 100, shares: 1000, fee: 0, tax: 0, total: 100000, ...overrides })

// 1. Existing backup code executes against an in-memory collection store.
const fixture = { 'kms/notes': [{ id: 'n', data: () => ({ title: 'note', content: '' }) }],
  'kms/noteBodies': [{ id: 'n', data: () => ({ content: 'essential body', assets: [{ id: 'asset' }] }) }] }
const backup = compile(read('src/lib/backup.ts'), {
  investDB: 'invest', kmsDB: 'kms', userCol: (db, col) => `${db}/${col}`,
  getDocs: async key => ({ docs: fixture[key] || [] }), getUID: () => 'fixture-user',
})
const exported = await backup.buildFullBackup()
assert.equal(exported.kms.noteBodies, undefined)
record('F01', Object.keys(exported.kms), 'include noteBodies and KMS settings; restore body and asset references')

// 2. Actual reconciliation routine, isolated from Firestore and Google.
let localDocs = []
const gcalSource = read('src/lib/googleCalendar.ts').replaceAll('import.meta.env.VITE_GOOGLE_CLIENT_ID', "'fixture-client'")
const gcal = compile(gcalSource, {
  investDB: 'invest', userCol: () => 'events', where: (...a) => a, query: (...a) => a,
  getDocs: async () => ({ docs: localDocs }),
}, 'export { reconcileATypeEvents };')
const iso = offset => { const d = new Date(); d.setDate(d.getDate() + offset); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}` }
for (const scenario of [
  { name: 'generated event', sourceId: 'investor-2330-fixture', date: iso(2), type: 'investor', local: false },
  { name: 'past local event', sourceId: 'past', date: iso(-2), type: 'personal', local: true },
  { name: 'deselected type', sourceId: 'disabled', date: iso(2), type: 'tech', local: true },
]) {
  localDocs = scenario.local ? [{ id: scenario.sourceId, data: () => ({ date: scenario.date, type: scenario.type, title: 'fixture' }) }] : []
  const result = await gcal.reconcileATypeEvents(['personal'], [{ sourceId: scenario.sourceId, googleEventId: 'g', date: scenario.date, title: 'fixture', updated: '', cancelled: false }])
  assert.deepEqual(result.deleteGoogleEventIds, ['g'])
  record(`F02-${scenario.name}`, result.deleteGoogleEventIds, 'no deletion without proof of local deletion')
}

// 3. FIFO repayment versus proportional remaining debt.
const buys = [trade({ id: 'a', price: 100, total: 40000, isMargin: true, marginRatio: .6 }),
  trade({ id: 'b', date: '2026-01-05', price: 200, total: 80000, isMargin: true, marginRatio: .6 })]
const sell = trade({ id: 's', date: '2026-01-06', type: 'sell', price: 200, isMargin: true })
const repay = calc.estimateMarginRepayment(sell, buys)
const debt = calc.aggregateMarginDebt([...buys, { ...sell, marginPrincipal: repay.principal }])
assert.equal(repay.principal, 60000)
assert.equal(debt, 90000)
record('F03', { repaid: repay.principal, remaining: debt, sum: repay.principal + debt }, { originalDebt: 180000, remaining: 120000 })

// 4. Actual custom CAGR callback; sell all 100000 cost for 110000.
let customReturn
const yearSource = read('src/pages/invest/YearReview.tsx')
const start = yearSource.indexOf('function calcXIRR('), end = yearSource.indexOf('\nfunction calcMDD', start)
const { calcXIRR } = compile(yearSource.slice(start, end), {}, 'export { calcXIRR };')
const runCagr = callback('src/pages/invest/YearReview.tsx', 'calcCustomCAGR', {
  customStart: '2026-01-02', customEnd: '2027-01-02', perfConfig: {},
  allTradesRef: { current: [trade({}), trade({ id: 'sell', date: '2026-06-01', type: 'sell', price: 110, total: 110000 })] },
  allDividendsRef: { current: [] }, allCashflowsRef: { current: [] }, savedPricesRef: { current: {} },
  calcPositions: calc.calcPositions, calcXIRR, setPerfLoading: () => {}, setCustomCAGR: v => { customReturn = v },
})
runCagr()
assert.ok(customReturn < -89 && customReturn > -91)
record('F04', customReturn, 'about +10% for a one-year period')

// 5. Lot rounding sells more shares than owned.
const plan = calc.calcPortfolioRebalance(100000, 0, [{ code: '2330', currentShares: 100, currentMarketValue: 10000, price: 100, targetWeightPct: 100 }], { lotSize: 1000 })
assert.equal(plan.rows[0].estimatedShares, 1000)
record('F05', { sharesToSell: plan.rows[0].estimatedShares, proceeds: plan.totalSell }, { maxShares: 100, maxProceeds: 10000 })

// 6. Client draft cleanup ignores a persisted noteBodies reference.
let localDrafts = JSON.stringify([{ assetId: 'asset', noteId: 'n', storagePath: 'users/fixture/notes/n/images/a.webp', createdAt: '2020-01-01' }])
const deletedPaths = [], checkedCollections = []
const images = compile(read('src/lib/kmsImages.ts'), {
  kmsAuth: { currentUser: { uid: 'fixture' } }, kmsDB: 'kms', kmsStorage: 'storage',
  localStorage: { getItem: () => localDrafts, setItem: (_, v) => { localDrafts = v } },
  userDoc: (_, col) => col, getDoc: async col => { checkedCollections.push(col); return { exists: () => col !== 'trash', data: () => col === 'noteBodies' ? { assets: [{ id: 'asset' }] } : { title: 'saved' } } },
  ref: (_, path) => path, deleteObject: async path => { deletedPaths.push(path) }, deleteDoc: async () => {},
})
await images.cleanupStaleNoteImageDrafts()
assert.equal(deletedPaths.length, 1)
assert.ok(!checkedCollections.includes('noteBodies'))
record('F06', { deletedPaths, checkedCollections }, 'retain asset referenced by noteBodies')

// 7. Snapshot session state leaks across users even when nothing is written.
let uid = 'a', reads = []
const snapshots = compile(read('src/lib/snapshot.ts'), {
  investDB: 'invest', userDoc: () => uid,
  getDoc: async key => { reads.push(key); return { exists: () => key === 'a' } },
  toLocalDateString: () => '2026-09-07', canRunAutoSnapshot: () => true,
})
assert.equal((await snapshots.maybeAutoSnapshotToday()).status, 'already-covered')
uid = 'b'
assert.equal((await snapshots.maybeAutoSnapshotToday()).status, 'already-covered')
assert.deepEqual(reads, ['a'])
record('F07', { readUsers: reads, secondUserStatus: 'already-covered' }, 'check user b independently')

// 8. KMS metadata function repeats increments for the same event.
let stats = {}
const fn = compile(read('firebase-functions/index.js'), {
  initializeApp: () => {}, getFirestore: () => ({ doc: path => path,
    runTransaction: async cb => cb({ get: async () => ({ exists: Object.keys(stats).length > 0, data: () => stats }), set: (_, data) => { stats = data } }) }),
  defineBoolean: () => ({ value: () => false }), onDocumentWritten: (_, cb) => cb, onSchedule: (_, cb) => cb,
})
const event = { id: 'same-event', params: { userId: 'fixture', noteId: 'n' }, data: {
  before: { exists: false }, after: { exists: true, data: () => ({ title: 'x', hashtags: ['tag'] }), ref: { update: async () => {} } },
} }
await fn.maintainKmsNoteMetadata(event)
await fn.maintainKmsNoteMetadata(event)
assert.equal(stats.totalNotes, 2)
record('F08', stats, { totalNotes: 1, counts: { tag: 1 } })

// 9. Reproduce actual AssetTrend memo callback at complete loss.
const trend = callback('src/pages/invest/AssetTrend.tsx', 'returnChartData', {
  filtered: [{ date: '2026-01-01', totalAssets: 100000 }, { date: '2026-01-02', totalAssets: 0 }],
  taiexData: {}, cashflows: [],
})()
assert.equal(trend[1].assetReturn, 0)
record('F09', trend[1].assetReturn, -100)

// 10. New KMS body sets an undefined contentDoc when no editor change occurred.
const source = read('src/pages/kms/KMSHome.tsx')
const bodyStart = source.indexOf('function noteBody('), bodyEnd = source.indexOf('\nfunction noteSummary', bodyStart)
const { noteBody } = compile(source.slice(bodyStart, bodyEnd), {}, 'export { noteBody };')
const body = noteBody({ title: 'blank', content: '' })
assert.ok(Object.hasOwn(body, 'contentDoc') && body.contentDoc === undefined)
record('F10', { hasContentDocProperty: true, valueType: typeof body.contentDoc }, 'omit undefined fields before Firestore write')

// Actual installed Firebase SDK validation, without commit or network access.
const sdkApp = initializeApp({ projectId: 'demo-audit-offline' }, 'audit-offline')
const sdkDb = getFirestore(sdkApp)
assert.throws(() => writeBatch(sdkDb).set(doc(sdkDb, 'notes', 'fixture'), body), /undefined/)
await deleteApp(sdkApp)

// 11. Partial quote success marks an old quote as refreshed in the stored map.
let storedPrices = { '2330': 100, '2317': 50, _updatedAt: '2000/1/1' }
let snapshotTriggered = false
const updatePrices = callback('src/PriceContext.tsx', 'updatePrices', {
  getMultipleQuotes: async () => ({ '2330': 110, '2317': null }),
  investDB: 'invest', userDocNested: () => 'prices',
  setDoc: async (_, data) => { storedPrices = { ...storedPrices, ...data } },
  setPrices: () => {}, setLastUpdated: () => {}, setPriceLoading: () => {},
  maybeAutoSnapshotToday: async () => { snapshotTriggered = true; return {} },
})
await updatePrices(['2330', '2317'])
assert.equal(storedPrices['2317'], 50)
assert.notEqual(storedPrices._updatedAt, '2000/1/1')
assert.equal(snapshotTriggered, true)
record('F11', { storedPrices, snapshotTriggered }, 'failed quote remains stale; automatic NAV must reject it')

// 12. Portfolio snapshot consumes scheduled future dividend now.
const portfolio = compile(read('src/lib/portfolioSnapshot.ts'), calc)
const futureSnapshot = portfolio.buildPortfolioSnapshot({ trades: [trade({})], dividends: [
  { code: '2330', date: '2099-01-01', name: 'fixture', cashDividend: 5000, stockDividend: 100 },
], cashflow: [{ date: '2026-01-01', type: 'in', amount: 100000 }], savedPrices: { '2330': 100 } })
assert.equal(futureSnapshot.cash, 5000)
assert.equal(futureSnapshot.holdings[0].shares, 1100)
record('F12', { cash: futureSnapshot.cash, shares: futureSnapshot.holdings[0].shares, netAssets: futureSnapshot.netAssets }, { cash: 0, shares: 1000, netAssets: 100000 })

// 13. Long-running restore retargets later writes if current user changes.
let restoreUid = 'a'
const restorePaths = []
const restore = compile(read('src/lib/backup.ts'), {
  investDB: 'invest', kmsDB: 'kms', userDoc: (_, col, id) => `${restoreUid}/${col}/${id}`,
  invalidateAllInvestData: () => {}, writeBatch: () => ({ set: path => restorePaths.push(path),
    commit: async () => { restoreUid = 'b' } }),
})
await restore.restoreFullBackup({ invest: { trades: Array.from({ length: 401 }, (_, i) => ({ id: String(i), data: { date: '2026-01-01' } })) }, kms: {} })
assert.equal(restorePaths[400], 'b/trades/400')
record('F13', { first: restorePaths[0], last: restorePaths[400] }, 'all writes pinned to initial user or abort on account change')

// 14. Scheduled Admin SDK cleanup accepts a client-supplied foreign path.
const adminDeletions = []
const cleanupFn = compile(read('firebase-functions/index.js'), {
  initializeApp: () => {}, defineBoolean: () => ({ value: () => true }),
  onSchedule: (_, cb) => cb, onDocumentWritten: (_, cb) => cb,
  getFirestore: () => ({
    collectionGroup: () => ({ where: () => ({ limit: () => ({ get: async () => ({ docs: [{
      ref: { path: 'users/fixture-a/imageUploadDrafts/d', delete: async () => {} },
      data: () => ({ noteId: 'n', assetId: 'asset', storagePath: 'users/fixture-b/notes/n/images/fixture.webp' }),
    }] }) }) }) }),
    doc: () => ({ get: async () => ({ exists: false }) }),
  }),
  getStorage: () => ({ bucket: () => ({ file: path => ({ delete: async () => { adminDeletions.push(path) } }) }) }),
})
await cleanupFn.cleanupKmsImageDrafts()
assert.equal(adminDeletions[0], 'users/fixture-b/notes/n/images/fixture.webp')
record('F14', { enabled: true, requestedDeletion: adminDeletions }, 'validate owner and allowed path before privileged deletion')

const tracked = execFileSync('git', ['ls-files'], { encoding: 'utf8' }).trim().split('\n')
const sourceFiles = tracked.filter(path => /\.(tsx?|m?js|cjs|py)$/.test(path))
const inventory = sourceFiles.map(path => {
  const text = read(path)
  return { path, lines: text.split('\n').length,
    imports: [...text.matchAll(/(?:from\s+|import\s*\()['"]([^'"]+)['"]/g)].map(match => match[1]),
    collections: [...new Set([...text.matchAll(/user(?:Col|Doc)\([^,]+,\s*['"]([^'"]+)['"]/g)].map(match => match[1]))],
  }
})
writeFileSync('docs/SYSTEM_AUDIT_2026-09-07_INVENTORY.json', JSON.stringify({
  sourceFiles: inventory.length, sourceLines: inventory.reduce((sum, file) => sum + file.lines, 0),
  routes: [...read('src/App.tsx').matchAll(/<Route\s+path="([^"]+)"/g)].map(match => match[1]),
  files: inventory,
}, null, 2) + '\n')
writeFileSync('docs/SYSTEM_AUDIT_2026-09-07_EVIDENCE.json', JSON.stringify({ mode: 'local mocks; assertions prove existing defects', observations }, null, 2) + '\n')
console.log(`Confirmed ${observations.length} defect scenarios. Evidence: docs/SYSTEM_AUDIT_2026-09-07_EVIDENCE.json`)
