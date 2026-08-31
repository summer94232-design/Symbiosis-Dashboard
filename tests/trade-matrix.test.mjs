import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'

async function importTypeScriptModule(relativePath) {
    const source = readFileSync(new URL(relativePath, import.meta.url), 'utf8')
    const output = ts.transpileModule(source, {
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    }).outputText
    return import(`data:text/javascript;base64,${Buffer.from(output).toString('base64')}`)
}

const calc = await importTypeScriptModule('../src/lib/calc.ts')

const FUNDING_CASES = [
    { label: '現股', isMargin: false },
    { label: '融資', isMargin: true },
]

const LOT_CASES = [
    { label: '整股', shares: 1000 },
    { label: '零股', shares: 100 },
]

const INSTRUMENT_CASES = [
    { label: '股票', code: '2330', name: '台積電', taxRate: 0.003 },
    { label: 'ETF', code: '006208', name: '富邦台50', taxRate: 0.001 },
]

const EXIT_CASES = [
    { label: '部分賣出', ratio: 0.4 },
    { label: '全數平倉', ratio: 1 },
]

const YEAR_CASES = [
    { label: '同年度', buyDate: '2026-01-10', sellDate: '2026-07-10' },
    { label: '跨年度', buyDate: '2025-12-20', sellDate: '2026-01-10' },
]

const BUY_PRICE = 100
const SELL_PRICE = 120
const MARGIN_RATIO = 0.6
const INITIAL_CASH = 500_000

function expectedFee(price, shares) {
    const minimum = shares < 1000 ? 1 : 20
    return Math.max(Math.floor(price * shares * 0.001425 * 0.6), minimum)
}

function expectedTax(price, shares, taxRate) {
    return Math.floor(price * shares * taxRate)
}

function expectedMarginDebt(gross, ratio = MARGIN_RATIO) {
    return Math.floor(gross * ratio / 1000) * 1000
}

function closeTo(actual, expected, message, epsilon = 1e-8) {
    assert.ok(
        Math.abs(actual - expected) <= epsilon,
        `${message}: expected ${expected}, received ${actual}`,
    )
}

for (const funding of FUNDING_CASES) {
    for (const lot of LOT_CASES) {
        for (const instrument of INSTRUMENT_CASES) {
            for (const exit of EXIT_CASES) {
                for (const year of YEAR_CASES) {
                    const title = `${funding.label}／${lot.label}／${instrument.label}／${exit.label}／${year.label}`

                    test(title, () => {
                        const buyShares = lot.shares
                        const sellShares = buyShares * exit.ratio
                        const buyGross = BUY_PRICE * buyShares
                        const sellGross = SELL_PRICE * sellShares
                        const buyFee = expectedFee(BUY_PRICE, buyShares)
                        const sellFee = expectedFee(SELL_PRICE, sellShares)
                        const sellTax = expectedTax(SELL_PRICE, sellShares, instrument.taxRate)
                        const debt = funding.isMargin ? expectedMarginDebt(buyGross) : 0
                        // 模擬券商實際償還金額：比例本金加 50 元利息。
                        const marginRepay = funding.isMargin ? debt * exit.ratio + 50 : 0
                        const expectedBuyTotal = funding.isMargin
                            ? buyGross - debt + buyFee
                            : buyGross + buyFee
                        const expectedSellTotal = funding.isMargin
                            ? sellGross - sellFee - sellTax - marginRepay
                            : sellGross - sellFee - sellTax

                        assert.equal(calc.calcFee(BUY_PRICE, buyShares), buyFee, '買入手續費')
                        assert.equal(calc.calcFee(SELL_PRICE, sellShares), sellFee, '賣出手續費')
                        assert.equal(calc.calcTax(SELL_PRICE, sellShares, instrument.code), sellTax, '交易稅')
                        assert.equal(calc.isETF(instrument.code), instrument.label === 'ETF', '商品類型')

                        const buy = {
                            id: `${title}-buy`,
                            date: year.buyDate,
                            createdAt: `${year.buyDate}T09:00:00.000Z`,
                            type: 'buy',
                            code: instrument.code,
                            name: instrument.name,
                            price: BUY_PRICE,
                            shares: buyShares,
                            fee: buyFee,
                            tax: 0,
                            isMargin: funding.isMargin,
                            marginRatio: MARGIN_RATIO,
                            marginAmount: debt,
                            marginRepay: 0,
                            total: expectedBuyTotal,
                        }
                        const sell = {
                            id: `${title}-sell`,
                            date: year.sellDate,
                            createdAt: `${year.sellDate}T10:00:00.000Z`,
                            type: 'sell',
                            code: instrument.code,
                            name: instrument.name,
                            price: SELL_PRICE,
                            shares: sellShares,
                            fee: sellFee,
                            tax: sellTax,
                            isMargin: funding.isMargin,
                            marginRatio: MARGIN_RATIO,
                            marginAmount: 0,
                            marginRepay,
                            total: expectedSellTotal,
                        }

                        assert.equal(calc.calcTradeTotal(buy), expectedBuyTotal, '買入收付金額')
                        assert.equal(calc.calcTradeTotal(sell), expectedSellTotal, '賣出收付金額')

                        // 反向輸入，確認跨年與一般案例都由交易時間軸決定，而非陣列順序。
                        const result = calc.calcPositions([sell, buy])
                        const position = result.holdings[instrument.code]
                        const buyCost = buyGross + buyFee
                        const averageCost = buyCost / buyShares
                        // 融資利息屬於實際交易成本；償還本金只減少負債，不影響損益。
                        const sellRevenue = sellGross - sellFee - sellTax - (funding.isMargin ? 50 : 0)
                        const soldCost = averageCost * sellShares
                        const expectedRealized = sellRevenue - soldCost
                        const remainingShares = buyShares - sellShares

                        assert.equal(result.realized.length, 1, '應產生一筆已實現損益')
                        assert.equal(result.realized[0].date, year.sellDate, '損益應歸屬賣出年度')
                        closeTo(result.realized[0].avgCost, averageCost, '已實現平均成本')
                        closeTo(result.realized[0].realized, expectedRealized, '已實現損益')
                        closeTo(result.realized[0].returnRate, expectedRealized / soldCost, '已實現報酬率')
                        assert.equal(position.shares, remainingShares, '剩餘股數')

                        if (exit.ratio === 1) {
                            assert.equal(position.totalCost, 0, '全數平倉成本歸零')
                            assert.equal(position.avgCost, 0, '全數平倉均價歸零')
                            assert.equal(position.marginAmount, 0, '全數平倉融資借款歸零')
                        } else {
                            closeTo(position.totalCost, buyCost - soldCost, '部分賣出剩餘成本')
                            closeTo(position.avgCost, averageCost, '部分賣出後平均成本不變')
                            closeTo(
                                position.marginAmount ?? 0,
                                funding.isMargin ? debt * (1 - exit.ratio) : 0,
                                '部分賣出後融資借款',
                            )
                        }

                        const expectedDebtAfterSell = funding.isMargin ? debt * (1 - exit.ratio) : 0
                        closeTo(calc.aggregateMarginDebt([sell, buy]), expectedDebtAfterSell, '融資彙總借款')

                        const availableCash = calc.calcAvailableCash(
                            [{ type: 'in', amount: INITIAL_CASH }],
                            [sell, buy],
                            [],
                        )
                        assert.equal(
                            availableCash,
                            INITIAL_CASH - expectedBuyTotal + expectedSellTotal,
                            '可用現金',
                        )
                    })
                }
            }
        }
    }
}

test('手續費最低門檻依單筆整股／零股判斷', () => {
    assert.equal(calc.calcFee(10, 100), 1)
    assert.equal(calc.calcFee(10, 1000), 20)
})

test('ETF 代號帶 .TW 仍使用 ETF 稅率', () => {
    assert.equal(calc.isETF('006208.TW'), true)
    assert.equal(calc.calcTax(100, 1000, '006208.TW'), 100)
})

test('現股與融資混合持倉：只賣現股不應減少融資借款', () => {
    const spotBuy = {
        id: 'spot-buy', date: '2026-01-01', createdAt: '2026-01-01T09:00:00Z',
        type: 'buy', code: '2330', name: '台積電', price: 100, shares: 1000,
        fee: 85, tax: 0, total: 100085, isMargin: false,
    }
    const marginBuy = {
        id: 'margin-buy', date: '2026-01-02', createdAt: '2026-01-02T09:00:00Z',
        type: 'buy', code: '2330', name: '台積電', price: 100, shares: 1000,
        fee: 85, tax: 0, total: 40085, isMargin: true, marginRatio: 0.6,
    }
    const spotSell = {
        id: 'spot-sell', date: '2026-01-03', createdAt: '2026-01-03T09:00:00Z',
        type: 'sell', code: '2330', name: '台積電', price: 110, shares: 1000,
        fee: 94, tax: 330, total: 109576, isMargin: false,
    }

    const result = calc.calcPositions([spotBuy, marginBuy, spotSell])
    assert.equal(result.holdings['2330'].shares, 1000)
    assert.equal(result.holdings['2330'].marginAmount, 60000)
    assert.equal(calc.aggregateMarginDebt([spotBuy, marginBuy, spotSell]), 60000)
})

test('現股與融資混合持倉：賣完融資股數後借款歸零', () => {
    const spotBuy = {
        id: 'spot-buy', date: '2026-01-01', type: 'buy', code: '2330', name: '台積電',
        price: 100, shares: 1000, fee: 85, tax: 0, total: 100085, isMargin: false,
    }
    const marginBuy = {
        id: 'margin-buy', date: '2026-01-02', type: 'buy', code: '2330', name: '台積電',
        price: 100, shares: 1000, fee: 85, tax: 0, total: 40085, isMargin: true, marginRatio: 0.6,
    }
    const marginSell = {
        id: 'margin-sell', date: '2026-01-03', type: 'sell', code: '2330', name: '台積電',
        price: 110, shares: 1000, fee: 94, tax: 330, total: 49576,
        isMargin: true, marginRepay: 60000,
    }

    const result = calc.calcPositions([spotBuy, marginBuy, marginSell])
    assert.equal(result.holdings['2330'].shares, 1000)
    assert.equal(result.holdings['2330'].marginAmount, 0)
    assert.equal(calc.aggregateMarginDebt([spotBuy, marginBuy, marginSell]), 0)
})
