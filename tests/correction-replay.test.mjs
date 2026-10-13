import test from 'node:test'
import assert from 'node:assert/strict'
import { prepareCorrectionScenario, replayCorrectionScenarios } from '../scripts/replay-broker-corrections.mjs'

const buy = (id, price, date = '2026-01-01') => ({ id, data: { date, type: 'buy', code: '2330', name: 'fixture', price, shares: 100, fee: 0, tax: 0, total: price * 100 } })
const backup = () => ({ invest: { trades: [buy('a', 100), buy('b', 200)], dividends: [], cashflow: [{ id: 'cash', data: { date: '2026-01-01', type: 'in', amount: 50000 } }] } })
const amountChange = { collection: 'trades', id: 'a', certainty: 'screenshot-confirmed', before: { price: 100, total: 10000 }, after: { price: 101, total: 10100 } }

test('replay changes only selected fields in memory; original data and unrelated rows are preserved', () => {
    const b = backup(), old = structuredClone(b)
    const scenario = prepareCorrectionScenario(b, [amountChange])
    assert.deepEqual(b, old)
    assert.deepEqual(scenario.invest.trades[1], b.invest.trades[1])
    assert.equal(scenario.invest.trades[0].data.price, 101)
    assert.equal(scenario.invest.trades[0].data.total, 10100)
})

test('replay refuses changed sources, missing/duplicate IDs, repeated patches, and fields outside scope', () => {
    assert.throws(() => prepareCorrectionScenario(backup(), [{ ...amountChange, before: { price: 99 } }]), /原值已改變/)
    assert.throws(() => prepareCorrectionScenario(backup(), [{ ...amountChange, id: 'missing' }]), /不存在/)
    const duplicate = backup(); duplicate.invest.trades.push(buy('a', 100))
    assert.throws(() => prepareCorrectionScenario(duplicate, [amountChange]), /ID 重複/)
    assert.throws(() => prepareCorrectionScenario(backup(), [amountChange, amountChange]), /重複更正/)
    assert.throws(() => prepareCorrectionScenario(backup(), [{ ...amountChange, after: { code: '2317' } }]), /欄位不在/)
    assert.throws(() => prepareCorrectionScenario(backup(), [{ ...amountChange, before: {} }]), /原值檢查/)
})

test('removing a fictitious cash deposit requires the user-confirmed classification and old values', () => {
    const change = { collection: 'cashflow', id: 'cash', action: 'remove', certainty: 'user-confirmed', before: { id: 'cash', amount: 50000 } }
    assert.equal(prepareCorrectionScenario(backup(), [change]).invest.cashflow.length, 0)
    assert.equal(backup().invest.cashflow.length, 1)
    assert.throws(() => prepareCorrectionScenario(backup(), [{ ...change, certainty: 'guessed' }]), /使用者確認/)
    assert.throws(() => prepareCorrectionScenario(backup(), [{ ...change, before: { amount: 49999 } }]), /原值已改變/)
})

test('a conditional earlier allocation is never silently applied to the direct-evidence scenario', () => {
    const b = backup()
    const sale = (id, date) => ({ id, data: { date, code: '2330', name: 'fixture', type: 'sell', price: 300, shares: 100, fee: 0, tax: 0, total: 30000 } })
    b.invest.trades.push(sale('first', '2026-01-02'), sale('second', '2026-01-03'))
    const allocation = (id, buyId, certainty) => ({ collection: 'trades', id, certainty, changeKind: 'inventory-allocation', before: { inventoryMatches: null }, after: { inventoryMatches: [{ buyId, shares: 100 }] } })
    const proposal = { kind: 'review-only-accounting-proposal', changes: [allocation('first', 'b', 'derived-from-later-offsets'), allocation('second', 'a', 'screenshot-confirmed')] }
    const result = replayCorrectionScenarios(b, proposal, [{ date: '2026-01-03', code: '2330', brokerRealized: 20000 }])
    assert.equal(result.directEvidence.status, 'needs-allocation-review')
    assert.equal(result.conditionalScenario.status, 'computed')
    assert.equal(result.conditionalScenario.exact, 1)
    assert.equal(result.conditionalScenario.conditions.length, 1)
    assert.equal(result.notImportable, true)
    assert.equal(result.readOnly, true)
})

test('unclassified assumptions and non-accounting proposals cannot become confirmed changes', () => {
    assert.throws(() => replayCorrectionScenarios(backup(), { kind: 'review-only-accounting-proposal', changes: [{ ...amountChange, certainty: undefined }] }), /未分類/)
    assert.throws(() => replayCorrectionScenarios(backup(), { kind: 'other', changes: [] }), /不是帳務核對草案/)
})

test('the cutoff date excludes future cash and stock purchases', () => {
    const b = backup(); b.invest.trades.push(buy('future', 300, '2026-02-01'))
    const result = replayCorrectionScenarios(b, { kind: 'review-only-accounting-proposal', changes: [] }, [], '2026-01-31')
    assert.equal(result.original.cash, 20000)
    assert.equal(result.original.holdings[0].shares, 200)
})

test('confirmed recurring-buy fees affect realized cost and fractional legacy cash separately, without changing other fees', () => {
    const entries = [
        ['2026-03-09', 72.97, 40, 2920.8, 2919],
        ['2026-03-13', 76.04, 38, 2891.5200000000004, 2890],
        ['2026-03-19', 76.4, 39, 2981.6000000000004, 2980],
        ['2026-03-25', 76.28, 39, 2976.92, 2975],
        ['2026-04-01', 75.34, 39, 2940.26, 2939],
    ]
    const trades = entries.map(([date, price, shares, total], i) => ({ id: `recurring-${i}`, data: { date, code: '0050', type: 'buy', price, shares, total, fee: 2, tax: 0 } }))
    trades.push({ id: 'sale', data: { date: '2026-06-08', code: '0050', type: 'sell', price: 100, shares: 195, fee: 16, tax: 19, total: 19465 } })
    trades.push({ id: 'ordinary', data: { date: '2026-06-09', code: '0050', type: 'buy', price: 130, shares: 40, fee: 4, tax: 0, total: 5204 } })
    const b = { invest: { trades, dividends: [], cashflow: [] } }, original = structuredClone(b)
    const changes = entries.map((row, i) => ({ collection: 'trades', id: `recurring-${i}`, certainty: 'screenshot-confirmed', before: { fee: 2, total: row[3] }, after: { fee: 1, total: row[4] } }))
    const result = replayCorrectionScenarios(b, { kind: 'review-only-accounting-proposal', changes }, [{ date: '2026-06-08', code: '0050', brokerRealized: 4762 }])
    assert.equal(result.original.comparisons[0].difference, -5)
    assert.equal(result.directEvidence.exact, 1)
    assert.ok(Math.abs(result.directEvidence.cash - result.original.cash - 8.1) < 1e-8)
    assert.equal(result.directEvidence.holdings[0].totalCost, 5204)
    assert.equal(prepareCorrectionScenario(b, changes).invest.trades.at(-1).data.fee, 4)
    assert.deepEqual(b, original)
})

test('direct confirmation of an earlier allocation removes the condition and resolves later lot availability', () => {
    const b = backup()
    b.invest.trades.push(...['2026-01-02', '2026-01-03'].map((date, i) => ({ id: `sale-${i}`, data: { date, code: '2330', type: 'sell', price: 300, shares: 100, total: 30000, fee: 0, tax: 0 } })))
    const changes = ['b', 'a'].map((buyId, i) => ({ collection: 'trades', id: `sale-${i}`, certainty: 'screenshot-confirmed', changeKind: 'inventory-allocation', before: { inventoryMatches: null }, after: { inventoryMatches: [{ buyId, shares: 100 }] } }))
    const samples = [{ date: '2026-01-02', code: '2330', brokerRealized: 10000 }, { date: '2026-01-03', code: '2330', brokerRealized: 20000 }]
    const result = replayCorrectionScenarios(b, { kind: 'review-only-accounting-proposal', changes }, samples)
    assert.equal(result.directEvidence.status, 'computed')
    assert.equal(result.directEvidence.exact, 2)
    assert.equal(result.conditionalScenario.conditions.length, 0)
    assert.deepEqual(result.directEvidence.comparisons, result.conditionalScenario.comparisons)
})
