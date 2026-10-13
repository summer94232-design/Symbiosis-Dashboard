// Read-only isolated reproductions of the CURRENT defects, not correctness tests.
// Only synthetic records are used. No Firebase, Google, quote or AI requests.
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { compile, read } from '../../tests/helpers/compile.mjs'

const evidence = []
const calc = compile(read('src/lib/calc.ts'))
const returns = compile(read('src/lib/performanceReturns.ts'))
const validation = compile(read('src/lib/investmentValidation.ts'), calc)
const integrity = compile(read('src/lib/ledgerIntegrity.ts'), calc)
const writes = compile(read('src/lib/ledgerWrites.ts'), { ...calc, ...validation, ...integrity })
const year = read('src/pages/invest/YearReview.tsx')
const yearMath = compile(year.slice(year.indexOf('function calcXIRR('), year.indexOf('function heatColor(')), {}, 'export { calcXIRR, calcMDD }')
const callback = fn => fn
const dividends = [
  { id: 'forecast', code: '2330', name: 'fixture', status: 'announced', date: '2026-09-01', cashPaymentDate: '2026-10-20', cashDividend: 1000, stockDividend: 0 },
  { id: 'paid', code: '2330', name: 'fixture', status: 'confirmed', date: '2026-08-20', cashPaymentDate: '2026-09-15', cashDividend: 2000, stockDividend: 0 },
]

// R01: execute actual monthly callback and HistoryPnL dividend filter.
let monthly
const month = compile(year.slice(year.indexOf('const calcMonthlyForYear ='), year.indexOf('const load = useCallback')), {
  useCallback: callback, ...calc, setMonthlyData: rows => { monthly = rows },
}, 'export { calcMonthlyForYear }')
month.calcMonthlyForYear(2026, [], dividends)
const historySource = read('src/pages/invest/HistoryPnL.tsx')
const history = compile(historySource.slice(historySource.indexOf('const filteredDividends ='), historySource.indexOf('const stockPerf =')), {
  useMemo: fn => fn(), dividends, search: '', inRange: () => true,
}, 'export { filteredDividends }')
const cash = calc.calcAvailableCash([], [], dividends, '2026-09-30')
assert.equal(cash, 2000)
assert.equal(history.filteredDividends.reduce((sum, row) => sum + row.cashDividend, 0), 3000)
assert.equal(monthly[7].dividend, 2000)
assert.equal(monthly[8].dividend, 1000)
evidence.push({ id: 'R01', cashAsOfSeptember30: cash, historyDividendTotal: 3000,
  yearReviewAugustDividend: monthly[7].dividend, yearReviewSeptemberDividend: monthly[8].dividend,
  correctSeptemberReceivedDividend: 2000, explanation: 'Forecast counted as income; confirmed dividend assigned to ex-date month instead of payment month.' })

// R02: same flows through the two currently used XIRR implementations.
const normal = [{ date: '2025-01-01', amount: -100 }, { date: '2026-01-01', amount: 110 }]
const loss = [{ date: '2025-01-01', amount: -100 }, { date: '2026-01-01', amount: 0.05 }]
const sharedNormal = returns.accountXirr(normal), localNormal = yearMath.calcXIRR(normal)
assert.ok(Math.abs(sharedNormal - localNormal) > 0.00001)
assert.equal(yearMath.calcXIRR(loss), null)
assert.ok(Math.abs(returns.accountXirr(loss) + 0.9995) < 1e-9)
let annual
const yearly = compile(year.slice(year.indexOf('const calcYearlyPerf ='), year.indexOf('// ── 根據已快取')), {
  useCallback: callback, ...yearMath, setYearlyPerf: rows => { annual = rows },
}, 'export { calcYearlyPerf }')
yearly.calcYearlyPerf([2026], { '2025-12-31': 100, '2026-12-31': 0.05 }, [])
assert.equal(annual[0].totalReturn, 0)
evidence.push({ id: 'R02', shared365DayPercent: sharedNormal * 100, yearReview365_25DayPercent: localNormal * 100,
  nearTotalLossSharedPercent: returns.accountXirr(loss) * 100, nearTotalLossYearReview: yearMath.calcXIRR(loss),
  yearlyDisplayedNearTotalLossPercent: annual[0].totalReturn })

// R03: historical period endpoints reuse today's quote, suppressing the price return.
let rangeStats
const rangeModule = compile(year.slice(year.indexOf('const calcRangeStats ='), year.indexOf('const loadPerformance =')), {
  useCallback: callback, ...yearMath, rangeStart: '2025-01-02', rangeEnd: '2026-01-02', realizedTrades: [],
  rawCashflowsRef: { current: [] }, posSnapshotRef: { current: { dates: ['2025-01-01'],
    snapshots: { '2025-01-01': { '2330': { shares: 1000, avgCost: 100, marginAmount: 0 } } },
    savedPrices: { '2330': 150 } } }, setRangeLoading() {}, setRangeStats: value => { rangeStats = value },
}, 'export { calcRangeStats }')
rangeModule.calcRangeStats()
assert.ok(Math.abs(rangeStats.xirr) < 1e-7)
evidence.push({ id: 'R03', historicalStartPrice: 100, historicalEndPrice: 120, currentlySavedPrice: 150,
  expectedNoFlowOneYearReturnPercent: 20, actualHistoricalRangePercent: rangeStats.xirr * 100,
  explanation: 'Both historical endpoints valued at the current saved price 150; actual historical prices are not queried.' })

// R04: cumulative realized PROFIT starts at zero; it is not an equity curve.
const profitCurve = [1000, 500]
const equityCurve = [100000, 101000, 100500]
assert.equal(yearMath.calcMDD(profitCurve), 0.5)
assert.ok(Math.abs(yearMath.calcMDD(equityCurve) - 500 / 101000) < 1e-12)
evidence.push({ id: 'R04', realizedProfits: [1000, -500], displayedProfitCurveDrawdownPercent: 50,
  equityDrawdownOnSameClosedTradesPercent: 500 / 101000 * 100,
  initialLossCurveDrawdownPercent: yearMath.calcMDD([-1000, -2000]) * 100,
  explanation: 'Display discloses realized-PnL basis, but standard MDD label and percentage have a different denominator.' })

// R05: execute actual KMS exporter and body loaders, switch synthetic session
// between batches. IDs can overlap across accounts after preserving a backup.
let uid = 'A', downloaded = '', reads = 0
const kms = compile(read('src/lib/kmsData.ts'), {
  kmsDB: 'kms', userDoc: (_db, col, id) => ({ uid, col, id }),
  getDoc: async ref => { reads++; return { exists: () => true, data: () => ({ content: `${ref.uid}-body-${ref.id}` }) } },
})
const exportSource = read('src/pages/kms/KMSExport.tsx')
const exporter = compile(exportSource.slice(exportSource.indexOf('const handleExport ='), exportSource.indexOf('const exportCount =')), {
  ...kms, filteredNotes: Array.from({ length: 21 }, (_, i) => ({ id: `n${i}`, title: `A-title-${i}`, hashtags: [] })),
  format: 'single-txt', filterMode: 'all', selectedTags: new Set(), toLocalDateString: () => '2026-10-04',
  setExporting() {}, setExportProgress: text => { if (text === '讀取正文 20 / 21') uid = 'B' },
  formatNote: note => `${note.title}|${note.content}`, downloadFile: text => { downloaded = text },
  alertAction: error => { throw new Error(error) },
}, 'export { handleExport }')
await exporter.handleExport()
assert.ok(downloaded.includes('A-title-0|A-body-n0'))
assert.ok(downloaded.includes('A-title-20|B-body-n20'))
evidence.push({ id: 'R05', initialUid: 'A', switchedUid: uid, reads,
  mixedTitleAndBody: 'A-title-20|B-body-n20', downloadedDespiteAccountChange: true,
  explanation: 'KMSExport and fetchKmsBodiesInBatches do not bind the initial session; a later batch follows the new account.' })

// R06: stock dividends expand the position lots, but not the margin debt ledger.
const buy = { id: 'margin-buy', date: '2026-08-03', code: '2330', name: 'fixture', type: 'buy', price: 100,
  shares: 1000, fee: 0, tax: 0, total: 40000, isMargin: true, marginRatio: 0.6, marginAmount: 60000 }
const stockDiv = { id: 'distribution', date: '2026-08-10', stockDistributionDate: '2026-09-01',
  code: '2330', name: 'fixture', status: 'confirmed', cashDividend: 0, stockDividend: 100 }
const sell = { id: 'margin-sell', date: '2026-09-02', code: '2330', name: 'fixture', type: 'sell', price: 100,
  shares: 1100, fee: 0, tax: 0, total: 50000, isMargin: true, marginRatio: 0.6,
  marginRepay: 60000, marginPrincipal: 60000, marginInterest: 0 }
assert.equal(validation.validateTradeForWrite(sell).valid, true)
const before = { trades: [buy], dividends: [stockDiv] }
const after = writes.validateLedgerWrites(before, [{ collection: 'trades', id: sell.id, data: sell }])
const afterPosition = calc.calcPositions(after.trades, after.dividends)
const marginPosition = calc.aggregateMarginPositions([buy])[0]
assert.equal(calc.calcSharesBeforeTrade(sell, [buy], [stockDiv]), 1100)
assert.equal(afterPosition.holdings['2330'].shares, 1100)
assert.equal(afterPosition.realized.length, 0)
evidence.push({ id: 'R06', holdingsAfterDistribution: 1100, marginSharesAfterDistribution: marginPosition.shares,
  preflightAvailableShares: 1100, ledgerValidationAcceptedSell: true,
  holdingsAfterAcceptedSell: afterPosition.holdings['2330'].shares, realizedRecordsAfterSell: 0,
  cashBeforeSell: calc.calcAvailableCash([], [buy], [stockDiv]), cashAfterSell: calc.calcAvailableCash([], [buy, sell], [stockDiv]),
  remainingDebtAfterSell: calc.aggregateMarginDebt([buy, sell]),
  explanation: 'Position validation accepts 1100 shares; MarginLedger has only 1000 and silently ignores that sale, while cash includes it.' })

// R07: an explicitly intraday quote passes snapshot quality checks.
const policy = compile(read('src/lib/pricePolicy.ts'), { toLocalDateString: date => date ? date.toISOString().slice(0, 10) : '2026-09-30' })
const windows = compile(read('src/lib/snapshotPolicy.ts'))
const saved = { '2330': 100, _quotes: { '2330': { price: 100, requestedAt: '2026-09-30T02:00:00Z',
  fetchedAt: '2026-09-30T02:00:01Z', sourceDate: '2026-09-30', sourceUpdatedAt: Date.parse('2026-09-30T02:00:00Z'),
  priceType: 'trade', status: 'success' } } }
assert.deepEqual(policy.stalePriceCodes(['2330'], saved, '2026-09-30'), [])
assert.equal(windows.canRunAutoSnapshot('background', new Date(2026, 8, 30, 10)), true)
const today = () => '2026-09-30'
const portfolio = compile(read('src/lib/portfolioSnapshot.ts'), { ...calc, ...policy, toLocalDateString: today })
const snap = compile(read('src/lib/snapshot.ts'), {
  ...portfolio, toLocalDateString: today, captureUserSession: () => ({ assertActive() {}, doc: () => 'fixture-ref' }),
  investDB: 'fixture-db', getDocFromServer: async () => ({ exists: () => true, data: () => saved }),
  fetchTrades: async () => [{ ...buy, isMargin: false, total: 100000, date: '2026-09-29' }],
  fetchDividends: async () => [], fetchCashflow: async () => [{ date: '2026-09-29', type: 'in', amount: 100000 }],
})
const built = await snap.buildTodaySnapshot()
assert.deepEqual(built.stale, [])
assert.equal(built.snapshot.totalAssets, 100000)
assert.equal(built.snapshot.cashflowBasis, 'after-close-v1')
const intradayReturn = returns.buildTimeWeightedReturns([
  { date: '2026-09-29', totalAssets: 100000 }, { date: '2026-09-30', totalAssets: 100000 },
], [], true).at(-1)
assert.equal(intradayReturn.assetReturn, 0)
evidence.push({ id: 'R07', taipeiQuoteTime: '10:00', rejectedAsStale: false, backgroundWindowAllows10AM: true,
  snapshotUsesAfterCloseBasis: built.snapshot.cashflowBasis,
  acceptedIntradaySnapshotReturnPercent: intradayReturn.assetReturn, assumedTrueClosingNAV: 110000,
  correctReturnIfClosingNAV110000Percent: 10,
  explanation: 'Quote source date and fetch date are checked, but closing provenance is not stored or verified before daily return calculations.' })

// R08: actual annual performance loader omits a year with dividends but no sales.
let annualStats
const noops = Object.fromEntries(['setXirrLoading', 'setRangeStart', 'setRangeEnd', 'setRealizedTrades',
  'setTotalWins', 'setTotalTrades', 'setWinRate', 'setAvgHoldingDays', 'setMdd', 'setXirr',
  'setXirrCost', 'setHeatmapData', 'setHasLoaded'].map(name => [name, () => {}]))
const annualLoader = compile(year.slice(year.indexOf('const loadPerformance ='), year.indexOf('// 初始載入 +')), {
  useCallback: callback, ...calc, ...yearMath, ...noops, prices: {},
  investDB: 'fixture-db', userDocNested: () => 'fixture-ref',
  getDoc: async () => ({ exists: () => false }), getUsablePrices: () => ({}),
  fetchTrades: async () => [{ ...buy, isMargin: false, total: 100000, date: '2025-01-03' }],
  fetchCashflow: async () => [{ date: '2025-01-03', type: 'in', amount: 100000 }],
  fetchDividends: async () => [{ ...dividends[1], date: '2025-08-20', cashPaymentDate: '2025-09-15' }],
  rawCashflowsRef: { current: [] }, posSnapshotRef: { current: {} }, toLocalDateString: () => '2026-10-04',
  setYearStats: rows => { annualStats = rows },
}, 'export { loadPerformance }')
await annualLoader.loadPerformance()
assert.deepEqual(annualStats, [])
evidence.push({ id: 'R08', year: 2025, confirmedDividendAmount: 2000, salesInYear: 0,
  annualPerformanceRows: annualStats.length,
  explanation: 'Year list is derived only from realized sales, so a dividend-only year disappears from advanced annual statistics.' })

writeFileSync(new URL('./evidence.json', import.meta.url), JSON.stringify({ workDate: '2026-10-04',
  appVersion: 'v26.10.4.4', productCodeChanged: false, syntheticDataOnly: true, reproductions: evidence }, null, 2) + '\n')
console.log(`Confirmed ${evidence.length} isolated audit cases; evidence.json written.`)
