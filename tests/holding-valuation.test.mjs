import test from 'node:test'
import assert from 'node:assert/strict'
import { compile, read } from './helpers/compile.mjs'

const calc = compile(read('src/lib/calc.ts'))
const dates = compile(read('src/lib/date.ts'))
const policy = compile(read('src/lib/pricePolicy.ts'), dates)
const portfolio = compile(read('src/lib/portfolioSnapshot.ts'), { ...calc, ...dates, ...policy })
const position = (overrides = {}) => ({ code: '2317', shares: 1000, totalCost: 253716, marginAmount: 0, ...overrides })
const trade = (overrides = {}) => ({ id: 'buy', date: '2026-07-01', code: '2327', name: 'fixture', type: 'buy',
    price: 500, shares: 100, fee: 42, tax: 0, total: 50042, ...overrides })

test('broker offset links override same-date ID order and conserve the unused purchase cost', () => {
    const rows = [trade({ id: 'a', date: '2026-05-18', price: 492.5, fee: 42, total: 49292 }),
        trade({ id: 'z', date: '2026-05-18', price: 476.5, shares: 50, fee: 20, total: 23845 }),
        trade({ id: 'sale', date: '2026-06-08', type: 'sell', price: 701, shares: 20, fee: 12, tax: 42, total: 13966,
            inventoryMatches: [{ buyId: 'z', shares: 20 }] })]
    const result = calc.calcPositions(rows)
    assert.equal(result.realized[0].realized, 4428)
    assert.equal(result.holdings['2327'].totalCost, 49292 + 14307)
    assert.equal(result.realized[0].avgCost * 20 + result.holdings['2327'].totalCost, 49292 + 23845)
    assert.deepEqual(calc.calcPositions([...rows].reverse()), result)
    assert.equal(result.realized[0].realized - calc.calcPositions(rows.map(t => ({ ...t, inventoryMatches: undefined }))).realized[0].realized, 320)
})

test('specified older inventory is reserved before automatic day trading and supports a partial day trade', () => {
    const old = trade({ id: 'old', shares: 1000, price: 100, fee: 0, total: 100000 })
    const today = trade({ id: 'today', date: '2026-07-02', shares: 1000, price: 110, fee: 0, total: 110000 })
    const sale = trade({ id: 'sale', date: '2026-07-02', type: 'sell', shares: 1000, price: 120, fee: 0, tax: 0, total: 120000,
        inventoryMatches: [{ buyId: 'old', shares: 1000 }] })
    const reserved = calc.calcPositions([old, today, sale])
    assert.equal(reserved.realized.length, 1)
    assert.equal(reserved.realized[0].category, 'inventory')
    assert.equal(reserved.holdings['2327'].totalCost, 110000)
    const partial = calc.calcPositions([old, today, { ...sale, shares: 2000, total: 240000 }])
    assert.deepEqual(partial.realized.map(x => [x.category, x.realized]), [['dayTrade', 10000], ['inventory', 20000]])
    assert.equal(partial.holdings['2327'].shares, 0)
})

test('invalid broker offsets fail visibly instead of silently falling back to FIFO', () => {
    const buy = trade()
    const sell = trade({ id: 'sale', date: '2026-07-02', type: 'sell', shares: 20, price: 550, fee: 9, tax: 33, total: 10958 })
    for (const links of [[], null, [{ buyId: 'missing', shares: 20 }], [{ buyId: 'buy', shares: 19 }],
        [{ buyId: 'buy', shares: 10 }, { buyId: 'buy', shares: 10 }], [{ buyId: 'buy', shares: -20 }]]) {
        assert.throws(() => calc.calcPositions([buy, { ...sell, inventoryMatches: links }]), /券商庫存沖抵/)
    }
    for (const change of [{ date: '2026-07-03' }, { code: '2330' }, { isMargin: true }, { shares: 19 }, { brokerAccount: 'different' }]) {
        assert.throws(() => calc.calcPositions([{ ...buy, ...change }, { ...sell, inventoryMatches: [{ buyId: 'buy', shares: 20 }] }]), /券商庫存沖抵/)
    }
})

test('ledger preflight blocks deleting a linked buy even when other inventory could cover the sale', () => {
    const integrity = compile(read('src/lib/ledgerIntegrity.ts'), calc)
    const before = { trades: [trade(), trade({ id: 'other' }), trade({ id: 'sale', date: '2026-07-02', type: 'sell', shares: 20,
        inventoryMatches: [{ buyId: 'buy', shares: 20 }] })], dividends: [] }
    const broken = { ...before, trades: before.trades.filter(t => t.id !== 'buy') }
    assert.throws(() => integrity.assertNoNewOversells(before, broken), /券商庫存沖抵/)
    assert.doesNotThrow(() => integrity.assertNoNewOversells(broken, before))
})

test('single-trade validation rejects malformed inventory links and backup parsing preserves valid links', () => {
    const validation = compile(read('src/lib/investmentValidation.ts'), calc)
    const sale = trade({ id: 'sale', type: 'sell', fee: 42, tax: 150, total: 49808, inventoryMatches: [{ buyId: 'old', shares: 100 }] })
    assert.equal(validation.validateTradeForWrite(sale).valid, true)
    for (const inventoryMatches of [[], null, [{ buyId: 'old', shares: 101 }], [{ buyId: 'old', shares: 50 }, { buyId: 'old', shares: 50 }]]) {
        assert.equal(validation.validateTradeForWrite({ ...sale, inventoryMatches }).valid, false)
    }
    const backup = compile(read('src/lib/backup.ts'))
    const parsed = backup.parseBackup(JSON.stringify({ format: 'symbiosis-full-backup', version: 2, invest: { trades: [{ id: sale.id, data: sale }] }, kms: {} }))
    assert.deepEqual(parsed.invest.trades[0].data.inventoryMatches, sale.inventoryMatches)
})

test('FIFO retains the screenshot-confirmed last buy lot and its unallocated one-dollar fee', () => {
    const trades = [trade(), trade({ id: 'new', date: '2026-07-08', price: 891, fee: 76, total: 89176 }),
        trade({ id: 'sell', date: '2026-07-17', type: 'sell', price: 705, shares: 199, fee: 120, tax: 420, total: 139755 })]
    const result = calc.calcPositions(trades)
    assert.equal(result.holdings['2327'].shares, 1)
    assert.equal(result.holdings['2327'].totalCost, 892)
    const soldCost = 50042 + 88284
    assert.equal(result.realized[0].avgCost * 199, soldCost)
    assert.equal(result.realized[0].realized, 139755 - soldCost)
    assert.equal(soldCost + result.holdings['2327'].totalCost, 50042 + 89176)
    assert.notEqual(calc.calcPositions(trades, [], { costMethod: 'moving-average' }).holdings['2327'].totalCost, 892)
})

test('FIFO remaining TSMC and MediaTek costs agree with screenshot amounts after partial sales', () => {
    for (const [code, price, shares, fee, sellShares, sellPrice, sellFee, tax, expectedCost, expectedPnL] of [
        ['2330', 2350, 75, 150, 74, 2395, 151, 531, 2352, null],
        ['2454', 3890, 40, 133, 39, 4105, 136, 480, 3894, 7640],
    ]) {
        const result = calc.calcPositions([
            trade({ code, price, shares, fee, total: price * shares + fee }),
            trade({ id: 'sell', date: '2026-08-17', type: 'sell', code, price: sellPrice, shares: sellShares, fee: sellFee, tax, total: sellPrice * sellShares - sellFee - tax }),
        ])
        assert.equal(result.holdings[code].totalCost, expectedCost)
        if (expectedPnL !== null) assert.equal(result.realized[0].realized, expectedPnL)
    }
})

test('repeated partial disposals conserve original lot cost and clear every last dollar at close', () => {
    const result = calc.calcPositions([
        trade({ shares: 3, price: 33.5, fee: 1, total: 101 }),
        ...[1, 2, 3].map(i => trade({ id: `sell${i}`, date: `2026-07-0${i + 1}`, type: 'sell', shares: 1, price: 40, fee: 1, tax: 0, total: 39 })),
    ])
    assert.equal(result.realized.reduce((sum, x) => sum + x.avgCost * x.shares, 0), 101)
    assert.equal(result.holdings['2327'].totalCost, 0)
    assert.equal(result.realized.reduce((sum, x) => sum + x.realized, 0), 16)
})

test('cash sales cannot consume financing lots even when financing was acquired first', () => {
    const result = calc.calcPositions([
        trade({ isMargin: true, marginAmount: 30000, total: 20042 }),
        trade({ id: 'cash', date: '2026-07-02', price: 600, fee: 51, total: 60051 }),
        trade({ id: 'sell', date: '2026-07-03', type: 'sell', price: 700, fee: 59, tax: 210, total: 69731 }),
    ])
    assert.equal(result.holdings['2327'].totalCost, 50042)
    assert.equal(result.holdings['2327'].marginAmount, 30000)
    assert.equal(result.realized[0].realized, 9680)
})

test('FIFO timeline handles distributions, beforeTrade and daily holdings without future lot leakage', () => {
    const buy = trade({ price: 100, shares: 10, fee: 1, total: 1001 })
    const sell = trade({ id: 'sell', date: '2026-07-03', type: 'sell', price: 100, shares: 15, fee: 1, tax: 4, total: 1495 })
    const dividends = [{ code: '2327', name: 'fixture', date: '2026-06-20', stockDistributionDate: '2026-07-02', stockDividend: 10, cashDividend: 0 }]
    assert.equal(calc.calcPositions([buy, sell], dividends, { beforeTrade: sell }).holdings['2327'].shares, 20)
    const result = calc.calcPositions([buy, sell], dividends, { includeDailyHoldings: true })
    assert.equal(result.dailyHoldings['2026-07-01']['2327'].shares, 10)
    assert.equal(result.dailyHoldings['2026-07-02']['2327'].shares, 20)
    assert.equal(result.holdings['2327'].totalCost, 251)
    assert.equal(result.realized[0].realized, 745)
})

test('confirmed 170-share purchase-price correction changes cost and cash by exactly 170', () => {
    const input = { asOf: '2026-09-12', dividends: [], savedPrices: { '3711': 618 },
        cashflow: [{ date: '2026-09-07', type: 'in', amount: 200000 }] }
    const before = portfolio.buildPortfolioSnapshot({ ...input, trades: [trade({ code: '3711', date: '2026-09-07', shares: 170, price: 615, fee: 89, total: 104639 })] })
    const after = portfolio.buildPortfolioSnapshot({ ...input, trades: [trade({ code: '3711', date: '2026-09-07', shares: 170, price: 616, fee: 89, total: 104809 })] })
    assert.equal(after.totalCost - before.totalCost, 170)
    assert.equal(after.cash - before.cash, -170)
    assert.equal(after.holdings[0].unrealizedPnL - before.holdings[0].unrealizedPnL, -170)
    assert.equal(after.marketValue, before.marketValue)
})

test('confirmed cash-stock screenshot: fee-inclusive cost and estimated exit charges reproduce -6813 / -2.69%', () => {
    const value = calc.calcHoldingValuation(position(), 248)
    assert.equal(value.marketValue, 248000)
    assert.equal(value.bookPnL, -5716)
    assert.equal(value.estimatedSellFee, 353)
    assert.equal(value.estimatedSellTax, 744)
    assert.equal(value.unrealizedPnL, -6813)
    assert.equal(value.returnRate.toFixed(2), '-2.69')
    // A display estimate must not replace actual discounted trade booking.
    assert.equal(calc.calcFee(248, 1000), 212)
    assert.equal(calc.calcFee(253.5, 1000), 216)
})

test('user-corrected odd-lot minimum does not reproduce the broker display minimum of 20', () => {
    const value = calc.calcHoldingValuation(position({ code: '2327', shares: 1, totalCost: 892 }), 544)
    assert.equal(value.estimatedSellFee, 1)
    assert.equal(value.estimatedSellTax, 1)
    assert.equal(value.unrealizedPnL, -350)
    assert.equal(value.unrealizedPnL - (-369), 19)
    const other = calc.calcHoldingValuation(position({ code: '2330', shares: 1, totalCost: 2352 }), 2410)
    // Minimum 1 does not mean all odd-lot orders cost exactly 1.
    assert.equal(other.estimatedSellFee, 3)
    assert.equal(other.unrealizedPnL, 48)
})

test('fractional quote value is retained for PnL and rate while settlement truncation stays separate', () => {
    const value = calc.calcHoldingValuation(position({ code: '3481', shares: 1, totalCost: 28 }), 47.7)
    assert.equal(value.marketValue, 47.7)
    assert.equal(value.unrealizedPnL, 18.7)
    assert.equal(value.returnRate.toFixed(2), '66.79')
    assert.equal(calc.calcGrossAmount(47.7, 1), 47)
})

test('stock and ETF estimates use their own sell tax, and an entire lot retains minimum 20', () => {
    assert.equal(calc.calcHoldingValuation(position({ totalCost: 1000 }), 1).estimatedSellFee, 20)
    const etf = calc.calcHoldingValuation(position({ code: '00631L', shares: 15000, totalCost: 510000 }), 35.82)
    assert.equal(etf.marketValue, 537300)
    assert.equal(etf.estimatedSellTax, 537)
    assert.equal(etf.estimatedSellFee, 765)
    assert.equal(etf.unrealizedPnL, 25998)
})

test('missing, failed, or invalid quotes never create estimated charges or fictitious losses', () => {
    for (const quote of [undefined, null, 0, -1, NaN, Infinity]) {
        const value = calc.calcHoldingValuation(position(), quote)
        assert.equal(value.currentPrice, null)
        assert.equal(value.marketValue, 253716)
        assert.equal(value.estimatedSellFee + value.estimatedSellTax, 0)
        assert.equal(value.unrealizedPnL, 0)
        assert.equal(value.returnRate, 0)
    }
    assert.equal(calc.calcHoldingValuation(position({ shares: 0, totalCost: 0 }), 248).unrealizedPnL, 0)
})

test('snapshot retains total ownership including lent shares, and estimated charges do not debit cash or NAV', () => {
    const input = {
        asOf: '2026-09-12',
        trades: [{ id: 'buy', date: '2026-08-01', code: '00631L', name: 'fixture', type: 'buy',
            price: 34, shares: 15000, fee: 436, tax: 0, total: 510436 }],
        dividends: [], cashflow: [{ date: '2026-08-01', type: 'in', amount: 600000 }],
        savedPrices: { '00631L': 35.82 },
    }
    // 9,000 in custody + 6,000 lent still represent the same 15,000 owned shares.
    const value = portfolio.buildPortfolioSnapshot(input)
    assert.equal(value.holdings[0].shares, 9000 + 6000)
    assert.equal(value.marketValue, 537300)
    assert.equal(value.cash, 89564)
    assert.equal(value.netAssets, 626864)
    assert.equal(value.holdings[0].unrealizedPnL, 25562)
    assert.equal(value.realizedPnL, 0)
    assert.equal(value.holdings[0].unrealizedPnL, calc.calcHoldingValuation(value.holdings[0], 35.82).unrealizedPnL)
    const unavailable = portfolio.buildPortfolioSnapshot({ ...input, savedPrices: {} })
    assert.equal(unavailable.cash, value.cash)
})

test('Dashboard and Holdings live refresh execute the same valuation as initial snapshot loading', () => {
    const holdings = [position(), position({ code: '3481', shares: 1, totalCost: 28 })]
    for (const quotes of [{ '2317': 248, '3481': 47.7 }, { '2317': null, '3481': NaN }]) {
        const dashboardSource = read('src/pages/invest/Dashboard.tsx')
        const dashboardBody = dashboardSource.slice(dashboardSource.indexOf('        let totalMarketValue = 0'), dashboardSource.indexOf('        // Quote completion', dashboardSource.indexOf('        let totalMarketValue = 0')))
        let dashboard
        compile(dashboardBody, { holdings, quotes, ...calc, setHoldings: value => { dashboard = value }, setHasPrice() {} })
        const holdingsSource = read('src/pages/invest/Holdings.tsx')
        const start = holdingsSource.indexOf('        setHoldings(prev => prev.map(h =>')
        const end = holdingsSource.indexOf('\n    }', start)
        let refreshed
        compile(holdingsSource.slice(start, end), { quotes, ...calc, setHoldings: fn => { refreshed = fn(holdings) } })
        for (const expected of holdings.map(h => ({ ...h, ...calc.calcHoldingValuation(h, quotes[h.code]) }))) {
            for (const rows of [dashboard, refreshed]) {
                const actual = rows.find(h => h.code === expected.code)
                for (const field of ['marketValue', 'currentPrice', 'unrealizedPnL', 'returnRate']) assert.equal(actual[field], expected[field])
            }
        }
    }
})

test('margin display retains equity denominator; estimated costs are not loan repayments', () => {
    const value = calc.calcHoldingValuation(position({ marginAmount: 150000 }), 248)
    assert.equal(value.unrealizedPnL, -6813)
    assert.equal(value.returnRate, -6813 / (253716 - 150000) * 100)
})
