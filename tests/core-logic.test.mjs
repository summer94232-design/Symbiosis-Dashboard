import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'

async function importTypeScriptModule(relativePath) {
    let source = readFileSync(new URL(relativePath, import.meta.url), 'utf8')
    if (source.includes("from './calc'")) {
        const calcSource = readFileSync(new URL('../src/lib/calc.ts', import.meta.url), 'utf8')
        const calcOutput = ts.transpileModule(calcSource, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
        source = source.replace("from './calc'", `from 'data:text/javascript;base64,${Buffer.from(calcOutput).toString('base64')}'`)
    }
    const output = ts.transpileModule(source, {
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    }).outputText
    return import(`data:text/javascript;base64,${Buffer.from(output).toString('base64')}`)
}

async function importInvestmentValidationModule() {
    const calcSource = readFileSync(new URL('../src/lib/calc.ts', import.meta.url), 'utf8')
    const calcOutput = ts.transpileModule(calcSource, {
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    }).outputText
    const calcUrl = `data:text/javascript;base64,${Buffer.from(calcOutput).toString('base64')}`
    const source = readFileSync(new URL('../src/lib/investmentValidation.ts', import.meta.url), 'utf8')
        .replace("from './calc'", `from '${calcUrl}'`)
    const output = ts.transpileModule(source, {
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    }).outputText
    return import(`data:text/javascript;base64,${Buffer.from(output).toString('base64')}`)
}

const calc = await importTypeScriptModule('../src/lib/calc.ts')
const taskOrder = await importTypeScriptModule('../src/lib/taskOrder.ts')
const { cache } = await importTypeScriptModule('../src/lib/cache.ts')
const dataHealth = await importTypeScriptModule('../src/lib/dataHealth.ts')
const investorMeetingMerge = await importTypeScriptModule('../src/lib/investorMeetingMerge.ts')
const snapshotPolicy = await importTypeScriptModule('../src/lib/snapshotPolicy.ts')
const brokerReconciliation = await importTypeScriptModule('../src/lib/brokerReconciliation.ts')
const brokerMonthlyReconciliation = await importTypeScriptModule('../src/lib/brokerMonthlyReconciliation.ts')
const investmentValidation = await importInvestmentValidationModule()
const returnComparison = await importTypeScriptModule('../src/lib/returnComparison.ts')

const trade = (overrides) => ({
    id: '', date: '2026-07-23', type: 'buy', code: '2330', name: '台積電',
    price: 100, shares: 100, fee: 0, tax: 0, total: 10000,
    ...overrides,
})

test('同期報酬為資產報酬率減去加權指數報酬率', () => {
    assert.equal(returnComparison.calculateReturnGap(103.65, 64.09), 39.56)
    assert.equal(returnComparison.calculateReturnGap(12.34, 18.9), -6.56)
    assert.equal(returnComparison.calculateReturnGap(0, 0), 0)
    assert.equal(returnComparison.calculateReturnGap(10, null), null)
})

test('自訂融資門檻會同步影響加碼緩衝與壓力測試', () => {
    const rules = { safeRatio: 170, maintenanceRatio: 140, liquidationRatio: 125 }
    const sim = calc.simulateMarginBuy(200000, 100000, 100, 1000, 0.6, rules)
    assert.equal(sim.bufferTo130, sim.newMarketValue - sim.newDebt * 1.4)
    assert.equal(sim.bufferTo120, sim.newMarketValue - sim.newDebt * 1.25)

    const stress = calc.calcMarginStress([{ code: '2330', marketValue: 200000 }], 100000, [0.1], rules)
    assert.ok(Math.abs(stress.dropTo130 - 0.3) < 1e-12)
    assert.ok(Math.abs(stress.dropTo120 - 0.375) < 1e-12)
    assert.equal(stress.scenarios[0].gapTo130, 40)
})

test('券商對帳文字可辨識西元與民國日期的成交列', () => {
    const rows = brokerReconciliation.parseBrokerStatementText(`
2026/08/05 買進 2330 台積電 成交價 1800 股數 100 手續費 154
115/08/12 賣出 2330 台積電 成交價 1850 股數 50 手續費 79 交易稅 277
    `)
    assert.equal(rows.length, 2)
    assert.deepEqual(rows.map(row => [row.date, row.type, row.code, row.price, row.shares]), [
        ['2026-08-05', 'buy', '2330', 1800, 100],
        ['2026-08-12', 'sell', '2330', 1850, 50],
    ])
})

test('元大 App 分行日期且沒有股票代號的 OCR 明細可以辨識並反查代號', () => {
    const rows = brokerReconciliation.parseBrokerStatementText(`
2026/ 元 太 a 灣 50 正 2 33.98 -102,027
說
08/19 普通 買 進 3,000 --
2026/ 台 達 電 1800.00 -90,076
說
08/19 盤 中 零 股 買 進 50 --
2026/ 強 茂 145.00 144,442
說
08/19 普通 賣 出 1,000 4,323
2026/。 臻 鼎 -KY 474.00 -94,881
說
08/19 盤 中 零 股 買 進 200 --
2026) BEE 1888.00 -94,476
Vv
08119 盤 中 零 股 買 進 50 --
    `)
    assert.equal(rows.length, 5)
    assert.deepEqual(rows.map(row => [row.date, row.type, row.price, row.shares]), [
        ['2026-08-19', 'buy', 33.98, 3000],
        ['2026-08-19', 'buy', 1800, 50],
        ['2026-08-19', 'sell', 145, 1000],
        ['2026-08-19', 'buy', 474, 200],
        ['2026-08-19', 'buy', 1888, 50],
    ])
    const resolved = brokerReconciliation.resolveBrokerTradeCodes(rows, [
        trade({ code: '00631L', name: '元大台灣50正2' }),
        trade({ code: '2308', name: '台達電' }),
        trade({ code: '2481', name: '強茂' }),
        trade({ code: '4958', name: '臻鼎-KY' }),
        trade({ date: '2026-08-19', code: '2308', name: '台達電', price: 1888, shares: 50 }),
    ])
    assert.deepEqual(resolved.map(row => row.code), ['00631L', '2308', '2481', '4958', '2308'])
    assert.equal(brokerReconciliation.countBrokerTradeCandidates(`2026/ 完整列\n2026) 被截斷列`), 2)
})

test('元大月對帳單只解析交易明細，並採成交日、股數與單價的正確欄位', () => {
    const statement = `
--- 月對帳單 第 1 頁 ---
對帳單期間：2026/07/01~2026/07/31 帳戶總覽
--- 月對帳單 第 2 頁 ---
上市、上櫃、興櫃交易明細
成交日期 交割日期 交易 類別 幣別 買賣 證券名稱 股數 單價 成交金額 手續費 代繳交易稅 客戶淨收(客戶淨付)
2026/07/06 2026/07/08 集中 TWD 買 00631L 元大台灣50正2 5,000 39.0500 195,250 166 (195,416)
2026/07/06 2026/07/08 集中 TWD 賣 2327 國巨* 300 1,015.0000 304,500 260 913 303,327
2026/07/17 2026/07/21 融資 TWD 賣 00631L 元大台灣50正2 4,000 34.8000 139,200 119 139 44,749 63,200 94,000 193
上市/櫃(TWD)合計 成交金額：638,950
上市、上櫃、興櫃庫存明細
0050 元大台灣50 7,591 102.8500 780,734
--- 月對帳單 第 4 頁 ---
CMA(資金管理帳戶)交易明細及帳面餘額
2026/07/08 TWD 元大台灣(集買) 195,416 212,475
`
    const rows = brokerReconciliation.parseBrokerStatementText(statement)
    assert.equal(brokerReconciliation.isYuantaMonthlyStatement(statement), true)
    assert.deepEqual(brokerReconciliation.extractBrokerStatementPeriod(statement), { from: '2026-07-01', to: '2026-07-31' })
    assert.equal(brokerReconciliation.countBrokerTradeCandidates(statement), 3)
    assert.equal(rows.length, 3)
    assert.deepEqual(rows.map(row => [row.date, row.type, row.code, row.shares, row.price]), [
        ['2026-07-06', 'buy', '00631L', 5000, 39.05],
        ['2026-07-06', 'sell', '2327', 300, 1015],
        ['2026-07-17', 'sell', '00631L', 4000, 34.8],
    ])
    assert.deepEqual(rows.map(row => [row.fee, row.tax, row.total, row.isMargin]), [
        [166, undefined, -195416, false],
        [260, 913, 303327, false],
        [119, 139, 44749, true],
    ])
    assert.equal(rows[2].marginRepay, 94193)
    assert.equal(rows[2].marginPrincipal, 94000)
    assert.equal(rows[2].marginInterest, 193)

    const check = brokerReconciliation.reconcileBrokerTrades([rows[2]], [{
        id: 'system-margin-sell', date: '2026-07-17', type: 'sell', code: '00631L', name: '元大台灣50正2',
        price: 34.8, shares: 4000, fee: 119, tax: 139, total: 44942, isMargin: true,
        marginPrincipal: 94000, marginInterest: 0, marginRepay: 94000,
    }], 'monthly')[0]
    assert.equal(check.status, 'mismatch')
    assert.deepEqual(check.marginCorrection, {
        brokerRepay: 94193,
        systemRepay: 94000,
        brokerInterest: 193,
        systemInterest: 0,
    })
})

test('元大月對帳單可讀取 CMA 月底餘額、庫存與現金股利', () => {
    const details = brokerMonthlyReconciliation.parseYuantaMonthlyDetails(`
上市、上櫃、興櫃庫存明細(集保、信用)
證券代號 證券名稱 集保庫存 參考價 市值
0050 元大台灣50 7,591 102.8500 780,734
00631L 元大台灣50正2 6,000 33.7000 202,200
合計： 13,591 982,934
CMA(資金管理帳戶)交易明細及帳面餘額
帳務日期 幣別 摘要 支出金額 存入金額 帳面餘額
2026/07/03 TWD 國巨*(現金股息) 7,788 158,044
2026/07/09 TWD 台積電(現金股息) 937 186,235
2026/07/31 TWD 月底結餘 1,064,860
合計 1,992,489 2,907,093
    `)
    assert.equal(details.cashBalance, 1064860)
    assert.equal(details.cashBalanceDate, '2026-07-31')
    assert.deepEqual(details.holdings.map(row => [row.code, row.shares]), [['0050', 7591], ['00631L', 6000]])
    assert.deepEqual(details.dividends.map(row => [row.date, row.name, row.amount]), [
        ['2026-07-03', '國巨*', 7788],
        ['2026-07-09', '台積電', 937],
    ])
})

test('元大 2026-05／06 真實月結樣本可固定驗證零股、ETF 與融資收付', () => {
    // 僅保存去識別化的代表成交，不包含帳號、姓名、PDF 或密碼。
    const statement = `
對帳單期間：2026/05/01~2026/05/31
上市、上櫃、興櫃交易明細
成交日期 交割日期 交易 類別 幣別 買賣 證券名稱 股數 單價 成交金額 手續費 代繳交易稅 客戶淨收(客戶淨付)
2026/05/12 2026/05/14 集中 TWD 買 2301 光寶科 61 245.5000 14,975 12 (14,987)
2026/05/18 2026/05/20 集中 TWD 賣 0050 元大台灣50 1,000 94.2000 94,200 80 94 94,026
2026/05/20 2026/05/22 融資 TWD 賣 3149 正達 1,000 57.3000 57,300 48 171 22,069 23,900 35,000 12
2026/05/29 2026/06/02 融資 TWD 賣 00910 第一金太空衛星 6,000 87.2000 523,200 447 523 223,888 200,400 298,000 342
上市/櫃(TWD)合計
`
    const rows = brokerReconciliation.parseBrokerStatementText(statement)
    assert.equal(rows.length, 4)
    assert.deepEqual(rows.map(row => [row.code, row.fee, row.tax, row.total]), [
        ['2301', 12, undefined, -14987],
        ['0050', 80, 94, 94026],
        ['3149', 48, 171, 22069],
        ['00910', 447, 523, 223888],
    ])
    assert.deepEqual(rows.slice(2).map(row => [row.marginRepay, row.marginPrincipal, row.marginInterest]), [
        [35012, 35000, 12],
        [298342, 298000, 342],
    ])

    const june = brokerReconciliation.parseBrokerStatementText(`
對帳單期間：2026/06/01~2026/06/30
上市、上櫃、興櫃交易明細
2026/06/01 2026/06/03 融資 TWD 賣 2317 鴻海 1,000 293.5000 293,500 250 880 125,341 112,000 167,000 29
2026/06/18 2026/06/23 融資 TWD 賣 6182 合晶 1,000 114.0000 114,000 97 342 45,549 46,000 68,000 12
上市/櫃(TWD)合計
`)
    assert.deepEqual(june.map(row => [row.code, row.total, row.marginPrincipal, row.marginInterest]), [
        ['2317', 125341, 167000, 29],
        ['6182', 45549, 68000, 12],
    ])
})

test('元大成交金額先捨去至整數元，零股收付與損益不保留角分', () => {
    assert.equal(calc.calcGrossAmount(245.5, 61), 14975)
    assert.equal(calc.calcGrossAmount(208.5, 31), 6463)
    assert.equal(calc.calcGrossAmount(23.85, 599), 14286)
    assert.equal(calc.calcTradeTotal({ type: 'buy', price: 245.5, shares: 61, fee: 12 }), 14987)
    assert.equal(calc.calcTradeTotal({ type: 'sell', price: 23.85, shares: 599, fee: 12, tax: 42 }), 14232)

    const result = calc.calcPositions([
        trade({ date: '2026-05-01', code: '2301', price: 200.5, shares: 31, fee: 5, total: 6220 }),
        trade({ date: '2026-05-12', type: 'sell', code: '2301', price: 245.5, shares: 31, fee: 6, tax: 22, total: 7582 }),
    ])
    assert.equal(result.realized[0].realized, 1362)
})

test('元大 2026-05／06 真實費稅與融資樣本符合自動公式', () => {
    assert.equal(calc.calcFee(390, 250), 83)
    assert.equal(calc.calcFee(318.5, 450), 122)
    assert.equal(calc.calcTax(94.2, 1000, '0050'), 94)
    assert.equal(calc.calcTax(318.5, 450, '6285'), 429)
    assert.equal(calc.calcMarginDebt(calc.calcGrossAmount(58.9, 1000), 0.6), 35000)
    assert.equal(calc.calcMarginDebt(calc.calcGrossAmount(86.85, 4000), 0.6), 208000)
    assert.equal(calc.calcTradeTotal({ type: 'buy', price: 58.9, shares: 1000, fee: 50, isMargin: true, marginRatio: 0.6 }), 23950)
    assert.equal(calc.calcTradeTotal({ type: 'sell', price: 57.3, shares: 1000, fee: 48, tax: 171, isMargin: true, marginRepay: 35012 }), 22069)

    const marginCases = [
        {
            buy: trade({ date: '2026-05-18', code: '3149', price: 58.9, shares: 1000, isMargin: true, marginRatio: 0.6, marginAmount: 35000 }),
            sell: trade({ date: '2026-05-20', type: 'sell', code: '3149', price: 57.3, shares: 1000, isMargin: true }),
            expected: { principal: 35000, interest: 12, total: 35012 },
        },
        {
            buy: trade({ date: '2026-05-29', code: '2317', price: 279, shares: 1000, isMargin: true, marginRatio: 0.6, marginAmount: 167000 }),
            sell: trade({ date: '2026-06-01', type: 'sell', code: '2317', price: 293.5, shares: 1000, isMargin: true }),
            expected: { principal: 167000, interest: 29, total: 167029 },
        },
        {
            buy: trade({ date: '2026-06-17', code: '6182', price: 114, shares: 1000, isMargin: true, marginRatio: 0.6, marginAmount: 68000 }),
            sell: trade({ date: '2026-06-18', type: 'sell', code: '6182', price: 114, shares: 1000, isMargin: true }),
            expected: { principal: 68000, interest: 12, total: 68012 },
        },
    ]
    marginCases.forEach(({ buy, sell, expected }) => {
        const estimate = calc.estimateMarginRepayment(sell, [buy])
        assert.deepEqual({ principal: estimate.principal, interest: estimate.interest, total: estimate.total }, expected)
    })
})

test('投資資料寫入驗證會阻擋無效日期、數字與矛盾帳務', () => {
    assert.equal(investmentValidation.validateCashflowForWrite({ date: '2026-02-30', type: 'in', amount: 100 }).valid, false)
    assert.equal(investmentValidation.validateCashflowForWrite({ date: '2026-02-28', type: 'in', amount: Number.NaN }).valid, false)
    assert.equal(investmentValidation.validateDividendForWrite({ date: '2026-05-01', code: '0050', name: '', cashDividend: 0, stockDividend: 0 }).valid, false)
    assert.equal(investmentValidation.validateSnapshotForWrite({ date: '2026-05-31', totalAssets: 1000, marketValue: 800, cash: 300, marginDebt: 0 }).valid, false)

    const validMarginSell = trade({
        date: '2026-05-20', type: 'sell', code: '3149', price: 57.3, shares: 1000,
        fee: 48, tax: 171, total: 22069, isMargin: true, marginRatio: 0.6,
        marginRepay: 35012, marginPrincipal: 35000, marginInterest: 12,
    })
    assert.equal(investmentValidation.validateTradeForWrite(validMarginSell).valid, true)
    assert.equal(investmentValidation.validateTradeForWrite({ ...validMarginSell, total: 22100 }).valid, false)
    assert.equal(investmentValidation.validateTradeForWrite({ ...validMarginSell, shares: 1.5 }).valid, false)
})

test('月底現金核對會把月底後待交割款換回 CMA 交割日口徑', () => {
    const brokerTrades = [
        { settlementDate: '2026-08-03', total: -112345 },
        { settlementDate: '2026-08-03', total: -46739 },
        { settlementDate: '2026-08-04', total: -101386 },
        { settlementDate: '2026-08-04', total: -102837 },
    ]
    const check = brokerMonthlyReconciliation.reconcileMonthlyCash(1064860, 701553, '2026-07-31', brokerTrades)
    assert.equal(check.unsettledNet, -363307)
    assert.equal(check.systemExpectedSettledCash, 1064860)
    assert.equal(check.status, 'matched')
})

test('月結庫存與股利核對會標記一致及缺漏', () => {
    const holdingChecks = brokerMonthlyReconciliation.reconcileMonthlyHoldings([
        { code: '0050', name: '元大台灣50', shares: 7591 },
        { code: '00631L', name: '元大台灣50正2', shares: 6000 },
    ], {
        '0050': { code: '0050', name: '元大台灣50', shares: 7591, avgCost: 100, totalCost: 759100 },
        '2330': { code: '2330', name: '台積電', shares: 100, avgCost: 2000, totalCost: 200000 },
    })
    assert.equal(holdingChecks.find(row => row.code === '0050').status, 'matched')
    assert.equal(holdingChecks.find(row => row.code === '00631L').status, 'missing-system')
    assert.equal(holdingChecks.find(row => row.code === '2330').status, 'missing-broker')

    const dividendChecks = brokerMonthlyReconciliation.reconcileMonthlyDividends([
        { date: '2026-07-09', code: '2330', name: '台積電', amount: 937, description: '' },
    ], [
        { date: '2026-06-20', code: '2330', name: '台積電', cashDividend: 937, stockDividend: 0 },
        { date: '2026-07-21', code: '0050', name: '元大台灣50', cashDividend: 1854, stockDividend: 0 },
    ], '2026-07-01', '2026-07-31')
    assert.equal(dividendChecks[0].status, 'matched')
    assert.equal(dividendChecks[1].status, 'pending-broker')
})

test('券商核對會合併分批成交，並區分截圖未涵蓋與正式缺漏', () => {
    const brokerRows = [
        { id: 'a', date: '2026-08-05', type: 'buy', code: '2330', name: '台積電', price: 1800, shares: 40, fee: 62, rawText: '' },
        { id: 'b', date: '2026-08-05', type: 'buy', code: '2330', name: '台積電', price: 1800, shares: 60, fee: 92, rawText: '' },
    ]
    const systemRows = [
        trade({ date: '2026-08-05', code: '2330', name: '台積電', price: 1800, shares: 100, fee: 154, total: 180154 }),
        trade({ date: '2026-08-06', code: '0050', name: '元大台灣50', price: 100, shares: 100, fee: 9, total: 10009 }),
    ]
    const interim = brokerReconciliation.reconcileBrokerTrades(brokerRows, systemRows, 'interim')
    assert.equal(interim.find(row => row.key.includes('2330'))?.status, 'matched')
    assert.equal(interim.find(row => row.key.includes('0050'))?.status, 'coverage-unknown')
    const monthly = brokerReconciliation.reconcileBrokerTrades(brokerRows, systemRows, 'monthly')
    assert.equal(monthly.find(row => row.key.includes('0050'))?.status, 'missing-broker')
})

test('倉位水位試算會正確計算應買進或賣出的金額', () => {
    const raise = calc.calcPositionAdjustment(500_000, 1_000_000, 55)
    assert.deepEqual(raise, {
        action: 'buy',
        currentPct: 50,
        targetPct: 55,
        amount: 50_000,
        targetMarketValue: 550_000,
    })

    const reduce = calc.calcPositionAdjustment(760_000, 1_000_000, 51)
    assert.equal(reduce.action, 'sell')
    assert.equal(reduce.amount, 250_000)
})

test('倉位水位試算拒絕無效自有資金，目標相同時不交易', () => {
    assert.equal(calc.calcPositionAdjustment(100, 0, 50), null)
    assert.equal(calc.calcPositionAdjustment(100, 200, -1), null)
    assert.equal(calc.calcPositionAdjustment(500_000, 1_000_000, 50)?.action, 'hold')
})

test('多檔組合試算會先套用總倉位，再拆分個股目標占比', () => {
    const result = calc.calcPortfolioRebalance(1_000_000, 80, [
        { code: '2330', currentMarketValue: 300_000, currentShares: 300, price: 1000, targetWeightPct: 50 },
        { code: '2454', currentMarketValue: 200_000, currentShares: 200, price: 1000, targetWeightPct: 30 },
        { code: '2308', currentMarketValue: 0, currentShares: 0, price: 400, targetWeightPct: 20 },
    ])
    assert.equal(result.targetStockMarketValue, 800_000)
    assert.equal(result.allocatedWeightPct, 100)
    assert.equal(result.rows[0].targetMarketValue, 400_000)
    assert.equal(result.rows[0].action, 'buy')
    assert.equal(result.rows[0].estimatedShares, 100)
    assert.equal(result.rows[1].action, 'buy')
    assert.equal(result.rows[2].estimatedShares, 400)
    assert.equal(result.totalBuy, 300_000)
})

test('多檔組合試算保留占比未滿提示所需總和，缺價格時不猜股數', () => {
    const result = calc.calcPortfolioRebalance(500_000, 60, [
        { code: '2330', currentMarketValue: 250_000, currentShares: 250, price: null, targetWeightPct: 50 },
    ])
    assert.equal(result.allocatedWeightPct, 50)
    assert.equal(result.rows[0].action, 'sell')
    assert.equal(result.rows[0].estimatedShares, null)
    assert.equal(calc.calcPortfolioRebalance(0, 60, []), null)
})

test('組合試算支援只加碼、整張交易與費稅估算', () => {
    const result = calc.calcPortfolioRebalance(1_000_000, 80, [
        { code: '2330', currentMarketValue: 500_000, currentShares: 500, price: 1000, targetWeightPct: 40 },
        { code: '0050', currentMarketValue: 100_000, currentShares: 500, price: 200, targetWeightPct: 60 },
    ], { mode: 'buy-only', lotSize: 1000, includeFees: true })
    assert.equal(result.rows[0].action, 'hold')
    assert.equal(result.rows[0].limitedByMode, true)
    assert.equal(result.rows[1].action, 'buy')
    assert.equal(result.rows[1].estimatedShares % 1000, 0)
    assert.ok(result.totalFees > 0)
    assert.equal(result.totalTaxes, 0)
})

test('組合風險檢查會辨識個股、產業、現金、融資與壓力損失超標', () => {
    const risk = calc.calcPortfolioRisk([
        { code: '2330', group: '半導體', projectedMarketValue: 600_000 },
        { code: '2454', group: '半導體', projectedMarketValue: 200_000 },
        { code: '0050', group: 'ETF', projectedMarketValue: 100_000 },
    ], 50_000, 300_000, 20, {
        maxSingleWeightPct: 50,
        maxGroupWeightPct: 60,
        minCashPct: 10,
        maxMarginPct: 40,
        minEtfWeightPct: 20,
        maxStressLoss: 100_000,
    })
    assert.equal(risk.projectedMarketValue, 900_000)
    assert.equal(risk.stressLoss, 180_000)
    assert.equal(risk.groupWeights[0].group, '半導體')
    for (const id of ['single-2330', 'group-半導體', 'cash-floor', 'margin-cap', 'etf-floor', 'stress-loss']) {
        assert.ok(risk.issues.some(issue => issue.id === id), id)
    }
})

test('組合風險檢查在無槓桿且限制內不產生警告', () => {
    const risk = calc.calcPortfolioRisk([
        { code: '0050', group: 'ETF', projectedMarketValue: 400_000 },
        { code: '2330', group: '半導體', projectedMarketValue: 300_000 },
    ], 300_000, 0, 10, {
        maxSingleWeightPct: 60,
        maxGroupWeightPct: 60,
        minCashPct: 20,
        maxMarginPct: 20,
        minEtfWeightPct: 40,
        maxStressLoss: 100_000,
    })
    assert.equal(risk.issues.length, 0)
    assert.equal(risk.stressedNetAssets, 930_000)
})

test('同日交易依 createdAt 穩定排序，不受輸入陣列順序影響', () => {
    const buy = trade({ id: 'buy', createdAt: '2026-07-23T01:00:00.000Z' })
    const sell = trade({ id: 'sell', type: 'sell', price: 120, total: 12000, createdAt: '2026-07-23T02:00:00.000Z' })
    const result = calc.calcPositions([sell, buy])
    assert.equal(result.realized.length, 1)
    assert.equal(result.realized[0].realized, 2000)
    assert.equal(result.holdings['2330'].shares, 0)
})

test('舊資料同日排序以文件 ID 固定，且比較器保持反對稱', () => {
    const a = trade({ id: 'a' })
    const b = trade({ id: 'b' })
    assert.equal(calc.compareTradeRecords(a, b), -calc.compareTradeRecords(b, a))
})

test('非法超賣不產生已實現損益，也不扣減合法持股', () => {
    const buy = trade({ id: 'buy', createdAt: '2026-07-23T01:00:00.000Z' })
    const oversell = trade({ id: 'sell', type: 'sell', shares: 150, createdAt: '2026-07-23T02:00:00.000Z' })
    const result = calc.calcPositions([buy, oversell])
    assert.equal(result.realized.length, 0)
    assert.equal(result.holdings['2330'].shares, 100)
})

test('融資賣出依 T+2 交割期間自動估算本金與利息', () => {
    const buy = trade({
        id: 'margin-buy', date: '2026-05-18', createdAt: '2026-05-18T01:00:00.000Z',
        code: '3149', price: 60, shares: 1000, isMargin: true, marginRatio: 0.6,
        marginAmount: 35000, marginInterestRate: 0.0625,
    })
    const sell = trade({
        id: 'margin-sell', date: '2026-05-20', createdAt: '2026-05-20T01:00:00.000Z',
        type: 'sell', code: '3149', price: 61, shares: 1000, isMargin: true,
    })
    assert.deepEqual(calc.estimateMarginRepayment(sell, [buy]), {
        principal: 35000,
        interest: 12,
        total: 35012,
        matchedShares: 1000,
        unmatchedShares: 0,
    })
})

test('融資利息的 T+2 交割會排除證交所連假', () => {
    const buy = trade({
        id: 'holiday-buy', date: '2026-04-02', createdAt: '2026-04-02T01:00:00.000Z',
        code: '3149', price: 60, shares: 1000, isMargin: true, marginRatio: 0.6,
        marginAmount: 35000, marginInterestRate: 0.0625,
    })
    const sell = trade({
        id: 'holiday-sell', date: '2026-04-07', createdAt: '2026-04-07T01:00:00.000Z',
        type: 'sell', code: '3149', price: 61, shares: 1000, isMargin: true,
    })
    const estimate = calc.estimateMarginRepayment(sell, [buy])
    assert.equal(estimate.principal, 35000)
    assert.equal(estimate.interest, 6)
})

test('融資利息會扣除於已實現損益，本金不會重複列為成本', () => {
    const buy = trade({ id: 'buy', date: '2026-05-18', price: 100, isMargin: true, marginRatio: 0.6 })
    const sell = trade({
        id: 'sell', date: '2026-05-20', type: 'sell', price: 110,
        isMargin: true, marginPrincipal: 6000, marginInterest: 12, marginRepay: 6012,
    })
    const result = calc.calcPositions([buy, sell])
    assert.equal(result.realized[0].realized, 988)
})

test('舊融資紀錄同日分筆賣出時，以合計償還額拆出利息', () => {
    const buy = trade({
        id: 'buy', date: '2026-07-01', createdAt: '2026-07-01T01:00:00.000Z',
        price: 37.75, shares: 8000, isMargin: true, marginRatio: 0.6,
    })
    const sellA = trade({
        id: 'sell-a', date: '2026-07-17', createdAt: '2026-07-17T01:00:00.000Z',
        type: 'sell', price: 40, shares: 4000, isMargin: true, marginRepay: 87113,
    })
    const sellB = trade({
        id: 'sell-b', date: '2026-07-17', createdAt: '2026-07-17T02:00:00.000Z',
        type: 'sell', price: 40, shares: 4000, isMargin: true, marginRepay: 94193,
    })
    const result = calc.calcPositions([buy, sellA, sellB])
    assert.equal(Math.round(result.realized.reduce((sum, row) => sum + row.realized, 0)), 17694)
})

test('超賣檢查採交易當下持股，並排除同日稍後才配發的股票股利', () => {
    const buy = trade({ id: 'buy', date: '2026-07-22', createdAt: '2026-07-22T01:00:00.000Z' })
    const target = trade({ id: 'target', type: 'sell', createdAt: '2026-07-23T02:00:00.000Z' })
    const dividends = [{ id: 'div', date: '2026-07-23', code: '2330', name: '台積電', cashDividend: 0, stockDividend: 20 }]
    assert.equal(calc.calcSharesBeforeTrade(target, [buy], dividends), 100)
})

test('篩選拖曳只替換可見插槽，完整 order 唯一且連續', () => {
    const all = [
        { id: 'hidden-a', order: 0 },
        { id: 'visible-b', order: 1 },
        { id: 'hidden-c', order: 2 },
        { id: 'visible-d', order: 3 },
    ]
    const visible = [all[1], all[3]]
    const result = taskOrder.reorderVisibleItems(all, visible, 'visible-d', 'visible-b')
    assert.deepEqual(result.map(x => x.id), ['hidden-a', 'visible-d', 'hidden-c', 'visible-b'])
    assert.deepEqual(result.map(x => x.order), [0, 1, 2, 3])
})

test('共用資料層會合併同一 key 的同時請求', async () => {
    cache.clear()
    let loads = 0
    let resolveLoader
    const loader = () => {
        loads++
        return new Promise(resolve => { resolveLoader = resolve })
    }
    const first = cache.getOrLoad('shared:test', loader)
    const second = cache.getOrLoad('shared:test', loader)
    assert.equal(loads, 1)
    resolveLoader({ ok: true })
    assert.deepEqual(await first, { ok: true })
    assert.deepEqual(await second, { ok: true })
    assert.equal(cache.get('shared:test').ok, true)
})

test('載入期間失效的舊資料不會重新寫回快取', async () => {
    cache.clear()
    let resolveLoader
    const request = cache.getOrLoad('stale:test', () => new Promise(resolve => { resolveLoader = resolve }))
    cache.invalidate('stale:test')
    resolveLoader('old')
    assert.equal(await request, 'old')
    assert.equal(cache.get('stale:test'), null)
})

test('背景快照只在本地 08:00–22:00 執行', () => {
    assert.equal(snapshotPolicy.canRunAutoSnapshot('background', new Date(2026, 6, 31, 7, 59)), false)
    assert.equal(snapshotPolicy.canRunAutoSnapshot('background', new Date(2026, 6, 31, 8, 0)), true)
    assert.equal(snapshotPolicy.canRunAutoSnapshot('background', new Date(2026, 6, 31, 21, 59)), true)
    assert.equal(snapshotPolicy.canRunAutoSnapshot('background', new Date(2026, 6, 31, 22, 0)), false)
})

test('使用者更新現價可在任何本地時間刷新快照', () => {
    assert.equal(snapshotPolicy.canRunAutoSnapshot('price-update', new Date(2026, 6, 31, 2, 17)), true)
    assert.equal(snapshotPolicy.canRunAutoSnapshot('price-update', new Date(2026, 6, 31, 23, 30)), true)
})

test('歷史快照會用最新帳本重算現金分解，但保留原始總資產避免製造假報酬', () => {
    const snapshots = [
        { date: '2026-08-01', totalAssets: 1_000, marketValue: 900, cash: 100, marginDebt: 0 },
        { date: '2026-08-02', totalAssets: 1_050, marketValue: 950, cash: 100, marginDebt: 0 },
    ]
    const trades = [trade({ date: '2026-08-02', price: 2, shares: 100, total: 200 })]
    const dividends = [{ date: '2026-08-02', code: '2330', name: '台積電', cashDividend: 10, stockDividend: 0 }]
    const cashflows = [{ date: '2026-08-01', type: 'in', amount: 500 }]

    const result = calc.reconcileSnapshotBreakdowns(snapshots, trades, dividends, cashflows)
    assert.equal(result[0].totalAssets, 1_000)
    assert.equal(result[0].cash, 500)
    assert.equal(result[0].marketValue, 500)
    assert.equal(result[1].totalAssets, 1_050)
    assert.equal(result[1].cash, 310)
    assert.equal(result[1].marketValue, 740)
})

test('資料健康中心能辨識超賣、失效連結與垃圾桶衝突', () => {
    const report = dataHealth.analyzeDataHealth({
        trades: [
            trade({ id: 'buy', date: '2026-07-22', shares: 10, createdAt: '2026-07-22T01:00:00Z' }),
            trade({ id: 'sell', date: '2026-07-23', type: 'sell', shares: 20, createdAt: '2026-07-23T01:00:00Z' }),
        ],
        dividends: [], cashflow: [], snapshots: [],
        notes: [{ id: 'note-1', title: '測試筆記', links: ['missing'] }],
        trash: [{ id: 'note-1', title: '測試筆記', deletedAt: '2026-07-20T00:00:00Z' }],
        now: new Date('2026-07-23T00:00:00Z'),
    })
    assert.ok(report.issues.some(issue => issue.id === 'oversell'))
    assert.ok(report.issues.some(issue => issue.id === 'broken-note-links'))
    assert.ok(report.issues.some(issue => issue.id === 'note-trash-collision'))
    assert.equal(report.counts.critical, 2)
})

test('資料健康中心按時間軸納入較早日期的股票股利', () => {
    const report = dataHealth.analyzeDataHealth({
        trades: [
            trade({ id: 'buy', date: '2026-07-20', shares: 10 }),
            trade({ id: 'sell', date: '2026-07-22', type: 'sell', shares: 15 }),
        ],
        dividends: [{ id: 'div', date: '2026-07-21', code: '2330', cashDividend: 0, stockDividend: 5 }],
        cashflow: [], snapshots: [], notes: [], trash: [],
    })
    assert.equal(report.issues.some(issue => issue.id === 'oversell'), false)
})

test('資料健康中心分開標示自我連結、無效日期與真正逾期垃圾', () => {
    const report = dataHealth.analyzeDataHealth({
        trades: [], dividends: [], cashflow: [], snapshots: [],
        notes: [{ id: 'self', title: '自我連結', links: ['self'] }],
        trash: [
            { id: 'invalid', title: '日期無效', deletedAt: 'not-a-date' },
            { id: 'expired', title: '已逾期', deletedAt: '2026-05-01T00:00:00Z' },
        ],
        now: new Date('2026-07-30T00:00:00Z'),
    })
    const selfLink = report.issues.find(issue => issue.id === 'self-note-links')
    const invalidDate = report.issues.find(issue => issue.id === 'invalid-trash-date')
    const expired = report.issues.find(issue => issue.id === 'expired-trash')
    assert.deepEqual(selfLink?.affectedIds, ['self'])
    assert.deepEqual(invalidDate?.affectedIds, ['invalid'])
    assert.deepEqual(expired?.affectedIds, ['expired'])
})

test('資料健康中心檢查缺價、未分類、名稱衝突與今日快照差異', () => {
    const report = dataHealth.analyzeDataHealth({
        trades: [
            trade({ id: 'a', code: '2330', name: '台積電' }),
            trade({ id: 'b', code: '2330', name: 'TSMC', date: '2026-07-24' }),
        ],
        dividends: [], cashflow: [], notes: [], trash: [],
        snapshots: [{ id: '2026-08-07', date: '2026-08-07', totalAssets: 90_000, marketValue: 80_000, cash: 10_000, marginDebt: 0 }],
        stockGroups: {},
        investmentSummary: {
            holdingCodes: ['2330'], missingPriceCodes: ['2330'],
            marketValue: 100_000, cash: 10_000, marginDebt: 0, totalAssets: 110_000,
            priceUpdatedAt: '2026/7/1 下午3:00:00',
        },
        now: new Date(2026, 7, 7, 12),
    })
    for (const id of ['stock-name-conflict', 'holding-price-missing', 'holding-group-missing', 'holding-price-stale', 'today-snapshot-mismatch']) {
        assert.ok(report.issues.some(issue => issue.id === id), id)
    }
})

test('法說會個人 override 可新增日期並隱藏全域日期', () => {
    const globalRows = [{
        id: '2330-2026-08',
        stockCode: '2330',
        stockName: '台積電',
        yearMonth: '2026-08',
        dates: ['2026-08-10', '2026-08-20'],
    }]
    const overrides = [{
        id: '2330-2026-08',
        stockCode: '2330',
        stockName: '台積電（個人）',
        yearMonth: '2026-08',
        dates: [],
        addedDates: ['2026-08-25', '2026-08-25'],
        removedDates: ['2026-08-10'],
    }]
    const result = investorMeetingMerge.mergeInvestorMeetings(globalRows, overrides)
    assert.equal(result.length, 1)
    assert.equal(result[0].stockName, '台積電（個人）')
    assert.deepEqual(result[0].dates, ['2026-08-20', '2026-08-25'])
})

test('只有個人資料的法說會可建立，全部日期隱藏後會從結果移除', () => {
    const personalOnly = [{
        id: '2454-2026-09',
        stockCode: '2454',
        stockName: '聯發科',
        yearMonth: '2026-09',
        dates: [],
        addedDates: ['2026-09-03'],
        removedDates: [],
    }]
    const created = investorMeetingMerge.mergeInvestorMeetings([], personalOnly)
    assert.deepEqual(created[0].dates, ['2026-09-03'])

    const hidden = investorMeetingMerge.mergeInvestorMeetings(created, [{
        ...personalOnly[0],
        addedDates: [],
        removedDates: ['2026-09-03'],
    }])
    assert.deepEqual(hidden, [])
})
