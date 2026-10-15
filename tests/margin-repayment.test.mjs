import test from 'node:test'
import assert from 'node:assert/strict'
import { compile, read } from './helpers/compile.mjs'

const calc = compile(read('src/lib/calc.ts'))
const repayment = compile(read('src/lib/marginRepayment.ts'), calc)
const validation = compile(read('src/lib/investmentValidation.ts'), calc)
const dates = compile(read('src/lib/date.ts'))
const policy = compile(read('src/lib/pricePolicy.ts'), dates)
const portfolio = compile(read('src/lib/portfolioSnapshot.ts'), { ...calc, ...dates, ...policy })
const csv = compile(read('src/lib/csv.ts'))
const reconciliation = compile(read('src/lib/brokerReconciliation.ts'), calc)
const buy = (overrides = {}) => ({ id: 'purchase', date: '2026-06-01', type: 'buy', code: '2330', name: 'fixture',
    shares: 3000, price: 116, fee: 297, tax: 0, isMargin: true, marginRatio: 0.6, marginAmount: 208000, total: 140297, ...overrides })
const sell = (overrides = {}) => ({ id: 'sale', date: '2026-06-15', type: 'sell', code: '2330', name: 'fixture',
    shares: 1000, price: 109.25, fee: 93, tax: 109, total: 38904, isMargin: true, marginRatio: 0.6,
    marginPrincipal: 69333, marginInterest: 811, marginRepay: 70144, marginRepayManual: true, ...overrides })

test('broker principal and interest update cash, realized PnL and the next FIFO debt together', () => {
    const original = sell()
    const principal = repayment.updateMarginRepayment(original, 'marginPrincipal', 70000)
    const corrected = repayment.updateMarginRepayment(principal, 'marginInterest', 144)
    assert.equal(original.marginPrincipal, 69333)
    assert.equal(corrected.marginRepay, 70144)
    assert.equal(corrected.total, original.total)
    assert.equal(corrected.fee, original.fee)
    assert.equal(corrected.tax, original.tax)
    assert.equal(corrected.marginRepayManual, true)
    assert.equal(validation.validateTradeForWrite(corrected).valid, true)
    assert.equal(calc.calcPositions([buy(), original]).realized[0].realized, -7862)
    assert.equal(calc.calcPositions([buy(), corrected]).realized[0].realized, -7195)
    assert.equal(calc.aggregateMarginDebt([buy(), corrected]), 138000)
    const next = sell({ id: 'next', date: '2026-06-16', marginPrincipal: undefined })
    assert.equal(calc.estimateMarginRepayment(next, [buy(), corrected]).principal, 69000)
    assert.equal(calc.calcAvailableCash([], [buy(), corrected], []), calc.calcAvailableCash([], [buy(), original], []))
})

test('editing the total preserves confirmed principal; invalid negative interest is never clamped away', () => {
    const original = sell({ marginPrincipal: 70000, marginInterest: 144 })
    const changed = repayment.updateMarginRepayment(original, 'marginRepay', 70200)
    assert.equal(changed.marginPrincipal, 70000)
    assert.equal(changed.marginInterest, 200)
    const invalid = repayment.updateMarginRepayment(original, 'marginRepay', 69999)
    assert.equal(invalid.marginInterest, -1)
    assert.equal(validation.validateTradeForWrite(invalid).valid, false)
    for (const value of [-1, 0.5, NaN, Infinity]) {
        assert.equal(validation.validateTradeForWrite(repayment.updateMarginRepayment(original, 'marginInterest', value)).valid, false)
    }
    assert.equal(repayment.updateMarginRepayment(original, 'marginInterest', 0).marginInterest, 0)
    assert.equal(validation.validateTradeForWrite({ ...original, marginRepay: 70145 }).valid, false)
    const zero = repayment.updateMarginRepayment(repayment.updateMarginRepayment(original, 'marginInterest', 0), 'marginPrincipal', 0)
    assert.equal(calc.aggregateMarginDebt([buy(), zero]), 208000)
    const cash = sell({ isMargin: false })
    assert.equal(repayment.updateMarginRepayment(cash, 'marginPrincipal', 70000), cash)
})

test('CSV re-import retains independent amounts, zero interest and legacy unknown breakdowns', () => {
    const [header, row] = csv.parseCSVRecords('融資本金,融資利息,融資償還金額\n70000,144,70144')
    const saved = repayment.importMarginRepaymentCsv(Object.fromEntries(header.map((key, i) => [key, row[i]])), true)
    assert.deepEqual(saved, { marginPrincipal: 70000, marginInterest: 144, marginRepay: 70144, marginRepayManual: true })
    assert.equal(repayment.importMarginRepaymentCsv({ 融資本金: '70000', 融資利息: '0', 融資償還金額: '70000' }, true).marginInterest, 0)
    assert.deepEqual(repayment.importMarginRepaymentCsv({ 融資償還金額: '70144' }, true), { marginRepay: 70144, marginRepayManual: true })
    assert.deepEqual(repayment.importMarginRepaymentCsv({ 融資本金: '70000', 融資償還金額: '70144' }, true), saved)
    assert.deepEqual(repayment.importMarginRepaymentCsv({ 融資利息: '144', 融資償還金額: '70144' }, true), saved)
    assert.deepEqual(repayment.importMarginRepaymentCsv({ 融資本金: '70000', 融資利息: '144' }, true), saved)
    assert.deepEqual(repayment.importMarginRepaymentCsv({ 融資償還金額: '70144' }, false), { marginRepay: 0, marginRepayManual: false })
    const invalid = repayment.importMarginRepaymentCsv({ 融資本金: 'oops', 融資利息: '144', 融資償還金額: '70144' }, true)
    assert.equal(validation.validateTradeForWrite({ ...sell(), ...invalid }).valid, false)
})

test('reconciliation detects a wrong breakdown even when the repayment and net cash match', () => {
    const broker = { ...sell(), marginPrincipal: 70000, marginInterest: 144 }
    const [result] = reconciliation.reconcileBrokerTrades([broker], [sell()], 'interim')
    assert.equal(result.status, 'mismatch')
    assert.equal(result.marginCorrection.brokerPrincipal, 70000)
    assert.equal(result.marginCorrection.brokerInterest, 144)
    assert.ok(result.differences.some(message => message.startsWith('融資本金')))
    const totalOnly = { ...broker, marginPrincipal: undefined, marginInterest: undefined }
    const [unknown] = reconciliation.reconcileBrokerTrades([totalOnly], [sell()], 'interim')
    assert.equal(unknown.marginCorrection, undefined)
})

const snapshot = (overrides = {}) => portfolio.buildPortfolioSnapshot({ asOf: '2026-06-30',
    trades: [buy({ id: 'cash', shares: 1000, price: 100, fee: 85, total: 100085, isMargin: false, marginAmount: 0 }),
        buy({ shares: 2000, price: 120, fee: 205, marginAmount: 144000, total: 96205 }),
        sell({ price: 130, fee: 111, tax: 390, total: 59399, marginPrincipal: 70000, marginInterest: 100, marginRepay: 70100 })],
    cashflow: [{ date: '2026-06-01', type: 'in', amount: 400000 }], dividends: [], savedPrices: { '2330': 125 }, ...overrides })

test('cash and margin inventory display separately while aggregate assets, shares, cost and debt stay conserved', () => {
    const result = snapshot()
    assert.equal(result.holdings.length, 1)
    assert.equal(result.holdingGroups.length, 2)
    const [cash, margin] = result.holdingGroups
    assert.deepEqual([cash.fundingType, margin.fundingType], ['cash', 'margin'])
    assert.notEqual(cash.positionKey, margin.positionKey)
    assert.equal(cash.shares, 1000)
    assert.equal(margin.shares, 1000)
    assert.equal(cash.totalCost, 100085)
    assert.equal(margin.totalCost, 120103)
    assert.equal(cash.marginAmount, 0)
    assert.equal(margin.marginAmount, 74000)
    assert.equal(cash.returnRate, cash.unrealizedPnL / cash.totalCost * 100)
    assert.equal(margin.returnRate, margin.unrealizedPnL / (margin.totalCost - margin.marginAmount) * 100)
    for (const key of ['shares', 'totalCost', 'marketValue', 'marginAmount']) {
        assert.equal(cash[key] + margin[key], result.holdings[0][key])
    }
    assert.equal(result.netAssets, 439109)
    const repriced = snapshot({ savedPrices: { '2330': 150 } })
    assert.deepEqual(repriced.holdingGroups.map(row => row.currentPrice), [150, 150])
    assert.deepEqual(repriced.holdingGroups.map(row => row.totalCost), [100085, 120103])
    const missing = snapshot({ savedPrices: {} })
    assert.deepEqual(missing.missingPriceCodes, ['2330'])
    assert.ok(missing.holdingGroups.every(row => row.currentPrice === null))
})

test('classified stock dividends join the correct funding class; unclassified dividends remain explicit', () => {
    const trades = [buy({ id: 'cash', isMargin: false, marginAmount: 0, shares: 1000, total: 116099, fee: 99 }),
        buy({ shares: 2000, fee: 198, marginAmount: 139000, total: 93198 })]
    const dividend = { id: 'div', code: '2330', name: 'fixture', date: '2026-06-02', stockDistributionDate: '2026-06-03',
        stockDividend: 300, cashDividend: 0, stockDividendMarginShares: 200 }
    const result = snapshot({ trades, dividends: [dividend] })
    assert.deepEqual(result.holdingGroups.map(row => [row.fundingType, row.shares]), [['cash', 1100], ['margin', 2200]])
    assert.equal(result.holdingGroups.reduce((sum, row) => sum + row.totalCost, 0), result.totalCost)
    assert.equal(result.holdingGroups.find(row => row.fundingType === 'margin').marginAmount, 139000)
    const pending = snapshot({ trades, dividends: [{ ...dividend, stockDividendMarginShares: undefined }] })
    assert.equal(pending.holdingGroups.find(row => row.fundingType === 'unclassified').shares, 300)
    assert.equal(pending.holdingGroups.reduce((sum, row) => sum + row.shares, 0), pending.holdings[0].shares)
})
