import test from 'node:test'
import assert from 'node:assert/strict'
import { compile, read } from './helpers/compile.mjs'
import { auditBrokerStatement } from '../scripts/audit-broker-statements.mjs'

const broker = compile(read('src/lib/brokerReconciliation.ts'))
const monthly = compile(read('src/lib/brokerMonthlyReconciliation.ts'))
const calc = compile(read('src/lib/calc.ts'))
// Small accounting fixtures only: no customer names, account IDs or full statements.
const dayTrades = `對帳單期間：2026/08/01~2026/08/31
上市、上櫃、興櫃交易明細
2026/08/28 2026/09/01 集中 TWD 買沖 00631L 元大台灣50正2 1,000 36.4100 36,410 31 (36,441)
2026/08/28 2026/09/01 集中 TWD 賣沖 00631L 元大台灣50正2 1,000 36.3300 36,330 31 36 36,263
上市/櫃(TWD)合計 成交金額：72,740 手續費：62 代繳交易稅：36 債息： 利息累計稅款： 客戶淨收(付)：(178)
上市、上櫃、興櫃庫存明細
00631L 元大台灣50正2 9,000 35.8200 322,380
合計： 9,000 322,380
有價證券借貸庫存及沖銷明細
出借開 00631L 元大台灣50正2 1150810 6 6 1.00 1150831 127 TWD 0.00 38 0 89.00
借券 整戶維持率: 留存保證金:TWD 0 出借股票市值: 214,920
訊息通知
CMA(資金管理帳戶)交易明細及帳面餘額
2026/08/17 TWD 委扣入金(上市櫃劃撥交割 68,731 68,731
2026/08/31 TWD 月底結餘 68,731
合計 0 68,731`

test('monthly buy/sell day-trade rows preserve signs and printed controls detect omissions', () => {
    const rows = broker.parseBrokerStatementText(dayTrades)
    assert.equal(rows.length, 2)
    assert.equal(broker.countBrokerTradeCandidates(dayTrades), 2)
    assert.deepEqual(rows.map(row => [row.type, row.total, row.brokerDayTrade]), [['buy', -36441, true], ['sell', 36263, true]])
    assert.deepEqual(broker.verifyBrokerStatementTotals(dayTrades, rows), [])
    assert.ok(broker.verifyBrokerStatementTotals(dayTrades, rows.slice(0, 1)).length > 0)
})

test('lending balance joins custody only after independently matching its market value', () => {
    const details = monthly.parseYuantaMonthlyDetails(dayTrades)
    assert.equal(details.holdings[0].shares, 9000)
    assert.equal(details.lentHoldings[0].shares, 6000)
    assert.equal(monthly.combinedBrokerHoldings(details)[0].shares, 15000)
    assert.equal(details.cashEntries[0].category, 'deposit')
    // Accrued lending income is not a CMA receipt.
    assert.equal(details.cashEntries.length, 1)
    const invalid = monthly.parseYuantaMonthlyDetails(dayTrades.replace('214,920', '220,000'))
    assert.equal(invalid.lendingVerified, false)
    assert.equal(monthly.combinedBrokerHoldings(invalid)[0].shares, 9000)
})

test('fully returned lending never adds original loan quantity to month-end inventory', () => {
    const text = dayTrades.replace('1150810 6 6 1.00 1150831 127', '1150810 6 1.00 1150831 6 127').replace('214,920', '0')
    const details = monthly.parseYuantaMonthlyDetails(text)
    assert.equal(details.lendingVerified, true)
    assert.deepEqual(details.lentHoldings, [])
})

test('zero-tax sale at a page boundary does not consume footer digits', () => {
    const text = `上市、上櫃、興櫃交易明細 2026/08/06 2026/08/10 集中 TWD 賣 6757 台灣虎航 1 56.7000 56 1 55 3/6 --- 下一頁 4 --- 上市、上櫃、興櫃庫存明細`
    const [row] = broker.parseBrokerStatementText(text)
    assert.equal(row.total, 55)
    assert.equal(row.tax, 0)
})

test('integer gross amounts survive binary noise while real fractional dollars truncate', () => {
    assert.equal(calc.calcGrossAmount(34.8, 7000), 243600)
    assert.equal(calc.calcGrossAmount(33.98, 3000), 101940)
    assert.equal(calc.calcGrossAmount(29.11, 29), 844)
    assert.equal(calc.calcGrossAmount(27.78, 29), 805)
})

test('formal monthly reconciliation exposes sub-dollar differences and cash signs', () => {
    const [buy] = broker.parseBrokerStatementText(dayTrades)
    const system = { ...buy, total: 36441.19, fee: 31, tax: 0 }
    assert.equal(broker.reconcileBrokerTrades([buy], [system], 'monthly')[0].status, 'mismatch')
    assert.equal(broker.reconcileBrokerTrades([buy], [system], 'interim')[0].status, 'matched')
    assert.equal(broker.reconcileBrokerTrades([buy], [{ ...system, total: -36441 }], 'monthly')[0].status, 'mismatch')
})

test('margin repayment agreement does not hide wrong net cash', () => {
    const b = { id: 'b', date: '2026-06-04', code: '2317', name: '鴻海', type: 'sell', isMargin: true, price: 301.5, shares: 1000, fee: 257, tax: 904, total: 113243, marginRepay: 187096, rawText: '' }
    const result = broker.reconcileBrokerTrades([b], [{ ...b, total: 113339 }], 'monthly')[0]
    assert.equal(result.status, 'mismatch')
    assert.ok(result.differences.some(value => value.includes('淨收付')))
})

test('CMA bridge ignores future trades and reports even one-dollar mismatch', () => {
    const rows = broker.parseBrokerStatementText(dayTrades)
    const result = monthly.reconcileMonthlyCash(1000, 822, '2026-08-31', [...rows, { date: '2026-09-01', settlementDate: '2026-09-03', total: -999 }])
    assert.equal(result.status, 'matched')
    assert.equal(result.unsettledNet, -178)
    assert.equal(monthly.reconcileMonthlyCash(1001, 822, '2026-08-31', rows).status, 'mismatch')
})

test('dividend matching honors explicit payment dates and rejects another quarter', () => {
    const statement = [{ date: '2026-08-10', code: '0050', name: '元大台灣50', amount: 1844, description: '基金配息' }]
    const old = { date: '2026-01-22', code: '0050', name: '元大台灣50', cashDividend: 1844, stockDividend: 0 }
    assert.equal(monthly.reconcileMonthlyDividends(statement, [old], '2026-08-01', '2026-08-31')[0].status, 'missing-system')
    const paid = { ...old, date: '2026-07-21', cashPaymentDate: '2026-08-10' }
    assert.equal(monthly.reconcileMonthlyDividends(statement, [paid])[0].status, 'matched')
    assert.equal(monthly.reconcileMonthlyDividends(statement, [{ ...paid, cashPaymentDate: '2026-09-10' }])[0].status, 'missing-system')
    const pending = monthly.reconcileMonthlyDividends([], [paid], '2026-08-01', '2026-08-31')
    assert.equal(pending[0].date, '2026-08-10')
})

test('read-only audit uses as-of payment date and preserves backup snapshots', () => {
    const backup = { invest: { trades: [], cashflow: [], dividends: [{ id: 'd', data: { date: '2026-08-01', cashPaymentDate: '2026-09-01', cashDividend: 200, code: '0050', name: 'ETF', stockDividend: 0 } }], assetSnapshots: [{ id: '2026-08-31', data: { date: '2026-08-31', cash: 777, marketValue: 0, totalAssets: 777 } }] } }
    const before = JSON.stringify(backup)
    const result = auditBrokerStatement(backup, dayTrades)
    assert.equal(result.cash.systemProjectedCash, 0)
    assert.equal(result.valuation.storedSnapshot.totalAssets, 777)
    assert.equal(JSON.stringify(backup), before)
    assert.throws(() => auditBrokerStatement(backup, dayTrades + dayTrades), /逐份/)
})
