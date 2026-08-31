import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'

const compile = path => ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText
const url = code => `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`
const calcUrl = url(compile('../src/lib/calc.ts'))
const calc = await import(calcUrl)
const csv = await import(url(compile('../src/lib/dayTradeCsv.ts')))
const validation = await import(url(compile('../src/lib/investmentValidation.ts').replace("'./calc'", `'${calcUrl}'`)))
const health = await import(url(compile('../src/lib/dataHealth.ts').replace("'./calc'", `'${calcUrl}'`)))
const trade = overrides => {
    const t = { id: 'buy', date: '2026-08-28', type: 'buy', code: '2330', name: '台積電', price: 110, shares: 1000, fee: 0, tax: 0, ...overrides }
    return { ...t, total: calc.calcTradeTotal(t) }
}
const old = trade({ id: 'old', date: '2026-08-01', price: 100 })
const buy = trade({ id: 'buy', sequence: 2 })
const sell = trade({ id: 'sell', type: 'sell', price: 115, sequence: 1, dayTradeMatches: [{ buyId: 'buy', shares: 1000 }] })
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-7, `${a} != ${b}`)
const pnl = result => result.realized.reduce((sum, r) => sum + r.realized, 0)

test('未指定配對的先買後賣與先賣後買都自動保留舊庫存，且不寫回原始資料', () => {
    for (const sequence of [1, 3]) {
        const s = trade({ ...sell, sequence, dayTradeMatches: undefined })
        const rows = [old, buy, s]
        const original = structuredClone(rows)
        for (const input of [rows, [...rows].reverse()]) {
            const analysis = calc.analyzeDayTrades(input)
            assert.equal(analysis.automatic.length, 1)
            assert.equal(analysis.confirmed.length, 0)
            const result = calc.calcPositions(input, [], { includeDailyHoldings: true })
            assert.equal(result.holdings['2330'].avgCost, 100)
            assert.equal(result.dailyHoldings['2026-08-28']['2330'].totalCost, 100000)
            assert.equal(pnl(result), 5000)
            assert.equal(calc.calcSharesBeforeTrade(s, input), 2000)
        }
        assert.deepEqual(rows, original)
    }
})

test('補登、改價、刪除買入後即時重算自動沖抵，不留下失效人工連結', () => {
    const s = trade({ ...sell, sequence: 3, dayTradeMatches: undefined })
    assert.equal(pnl(calc.calcPositions([old, s])), 15000)
    assert.equal(pnl(calc.calcPositions([old, buy, s])), 5000)
    assert.equal(pnl(calc.calcPositions([old, trade({ ...buy, price: 112 }), s])), 3000)
    assert.equal(calc.analyzeDayTrades([old, s]).issues.length, 0)
    assert.equal(calc.analyzeDayTrades([old, s]).automatic.length, 0)
})

test('自動配對無需文件 ID，日末成本及損益一致', () => {
    const rows = [old, buy, { ...sell, dayTradeMatches: undefined }].map(t => ({ ...t, id: undefined }))
    const result = calc.calcPositions(rows)
    assert.equal(calc.analyzeDayTrades(rows).automatic.length, 1)
    assert.equal(result.holdings['2330'].avgCost, 100)
    assert.equal(pnl(result), 5000)
})

test('自動配對多筆成交不重用容量，人工部分指定不自動追加', () => {
    const b = trade({ ...buy, shares: 3000 })
    const s1 = trade({ ...sell, id: 's1', shares: 2000, dayTradeMatches: undefined })
    const s2 = trade({ ...sell, id: 's2', shares: 2000, dayTradeMatches: undefined })
    const automatic = calc.analyzeDayTrades([b, s2, s1])
    assert.deepEqual(automatic.automatic.map(p => p.shares), [2000, 1000])
    assert.equal(automatic.matchedShares.get(b), 3000)
    const manual = { ...s1, dayTradeMode: 'manual', dayTradeMatches: [{ buyId: 'buy', shares: 1000 }] }
    const mixed = calc.analyzeDayTrades([b, s2, manual])
    assert.equal(mixed.matchedShares.get(manual), 1000)
    assert.equal(mixed.matchedShares.get(s2), 2000)
})

test('排除後不沖抵，恢復自動會忽略舊人工連結', () => {
    const excluded = { ...sell, dayTradeMatches: [], dayTradeExcluded: true }
    assert.equal(calc.analyzeDayTrades([buy, excluded]).automatic.length, 0)
    const restored = { ...sell, dayTradeMode: 'auto', dayTradeMatches: [{ buyId: 'deleted', shares: 1000 }] }
    const result = calc.analyzeDayTrades([buy, restored])
    assert.equal(result.automatic.length, 1)
    assert.equal(result.issues.length, 0)
})

test('混合股數不推定市場，零股不加總湊成當沖整張', () => {
    const s = { ...sell, dayTradeMatches: undefined }
    const unknown = trade({ ...buy, shares: 1500 })
    const result = calc.analyzeDayTrades([unknown, s])
    assert.equal(result.automatic.length, 0)
    assert.equal(result.uncertain.length, 1)
    assert.equal(result.candidates[0].shares, 1000)
    const oddBuys = ['odd1', 'odd2'].map(id => trade({ ...buy, id, shares: 500 }))
    assert.equal(calc.analyzeDayTrades([...oddBuys, s]).automatic.length, 0)
    assert.equal(calc.analyzeDayTrades([trade({ ...buy, tradingSession: 'odd' }), s]).automatic.length, 0)
})

test('自動配對也排除跨日、跨股、跨帳戶、融資與鉅額', () => {
    for (const overrides of [{ date: '2026-08-27' }, { code: '2454' }, { brokerAccount: 'B' },
        { isMargin: true }, { tradingSession: 'block' }, { dayTradeExcluded: true }]) {
        const result = calc.analyzeDayTrades([trade({ ...buy, ...overrides }), { ...sell, dayTradeMatches: undefined }])
        assert.equal(result.automatic.length, 0)
    }
})

test('健康中心不將已自動沖抵的先賣後買列為超賣或待確認', () => {
    const rows = [buy, { ...sell, dayTradeMatches: undefined }]
    const issues = health.analyzeDataHealth({ trades: rows, dividends: [], cashflow: [], snapshots: [], notes: [], trash: [] }).issues
    assert.ok(!issues.some(i => ['oversell', 'daytrade-candidates', 'daytrade-invalid'].includes(i.id)))
})

test('CSV 保留人工零配對及自動模式，匯回後不改成本口徑', () => {
    for (const mode of ['auto', 'manual']) {
        const original = { ...sell, sequence: 3, dayTradeMode: mode, dayTradeMatches: [] }
        const imported = { ...original, ...csv.importDayTradeFields(csv.exportDayTradeFields(original)) }
        assert.equal(imported.dayTradeMode, mode)
        assert.equal(calc.analyzeDayTrades([buy, imported]).automatic.length, mode === 'auto' ? 1 : 0)
        assert.equal(validation.validateTradeForWrite(imported).valid, true)
    }
    assert.throws(() => csv.importDayTradeFields({ '當沖計算方式': 'invalid' }))
    assert.equal(validation.validateTradeForWrite({ ...sell, dayTradeMode: 'invalid' }).valid, false)
})

test('已確認當沖保留舊庫存成本；先賣後買、陣列順序均不改結果', () => {
    for (const rows of [[old, buy, sell], [sell, buy, old], [buy, old, sell]]) {
        const result = calc.calcPositions(rows)
        assert.equal(result.holdings['2330'].avgCost, 100)
        assert.equal(result.holdings['2330'].shares, 1000)
        assert.equal(pnl(result), 5000)
        assert.equal(result.realized[0].category, 'dayTrade')
        assert.equal(result.realized[0].holdingDays, 0)
        assert.equal(calc.calcSharesBeforeTrade(sell, rows), 2000)
    }
})

test('無舊庫存先賣後買仍可確認，超賣檢查只允許實際沖抵數量', () => {
    const result = calc.calcPositions([sell, buy])
    assert.equal(result.holdings['2330']?.shares || 0, 0)
    assert.equal(pnl(result), 5000)
    assert.equal(calc.calcSharesBeforeTrade(sell, [buy]), 1000)
    const tooLarge = trade({ ...sell, shares: 2000 })
    assert.equal(calc.calcSharesBeforeTrade(tooLarge, [buy]), 1000)
})

test('舊資料的空配對預設自動沖抵，不需選市場或逐筆確認', () => {
    const normalSell = { ...sell, sequence: 3, dayTradeMatches: [] }
    const rows = [old, buy, normalSell]
    assert.equal(calc.analyzeDayTrades(rows).automatic.length, 1)
    assert.equal(calc.analyzeDayTrades(rows).candidates.length, 0)
    assert.equal(calc.calcPositions(rows).holdings['2330'].avgCost, 100)
    assert.equal(pnl(calc.calcPositions(rows)), 5000)
})

test('人工指定零股數恢復一般移動平均，不被自動重新配對', () => {
    const normalSell = { ...sell, sequence: 3, dayTradeMode: 'manual', dayTradeMatches: [] }
    const rows = [old, buy, normalSell]
    assert.equal(calc.analyzeDayTrades(rows).automatic.length, 0)
    assert.equal(calc.calcPositions(rows).holdings['2330'].avgCost, 105)
    assert.equal(pnl(calc.calcPositions(rows)), 10000)
})

test('買超僅將剩餘買入併入庫存，分攤原始費用與稅', () => {
    const b = trade({ ...buy, shares: 2000, fee: 101 })
    const s = trade({ ...sell, fee: 31, tax: 172 })
    const result = calc.calcPositions([old, s, b])
    near(result.holdings['2330'].totalCost, 210050.5)
    near(result.holdings['2330'].avgCost, 105.02525)
    near(pnl(result), 4746.5)
    assert.equal(s.tax, 172)
})

test('賣超先沖當日買入，其餘扣舊庫存並拆成兩種損益', () => {
    const b = trade({ ...buy, fee: 100 })
    const s = trade({ ...sell, shares: 2000, fee: 200, tax: 400 })
    const result = calc.calcPositions([old, s, b])
    assert.equal(result.realized.length, 2)
    assert.deepEqual(result.realized.map(r => [r.category, r.shares, r.realized]), [['dayTrade', 1000, 4600], ['inventory', 1000, 14700]])
    assert.equal(result.holdings['2330'].shares, 0)
    assert.equal(result.realized[1].holdingDays, 27)
})

test('分批成交不重複使用同一買入股數', () => {
    const b = trade({ ...buy, shares: 3000 })
    const s1 = trade({ ...sell, id: 's1', shares: 2000, dayTradeMatches: [{ buyId: 'buy', shares: 2000 }] })
    const s2 = trade({ ...sell, id: 's2', shares: 2000, dayTradeMatches: [] })
    const result = calc.analyzeDayTrades([b, s2, s1])
    assert.equal(result.confirmed[0].shares, 2000)
    assert.equal(result.automatic[0].shares, 1000)
    const invalid = { ...s2, dayTradeMatches: [{ buyId: 'buy', shares: 2000 }] }
    assert.equal(calc.analyzeDayTrades([b, s1, invalid]).issues.length, 1)
})

test('同筆賣出配對多筆不同買價，以各筆實際成本計算', () => {
    const b2 = trade({ id: 'b2', price: 120, fee: 123 })
    const s = trade({ ...sell, shares: 2000, price: 125, fee: 111, tax: 333,
        dayTradeMatches: [{ buyId: 'buy', shares: 1000 }, { buyId: 'b2', shares: 1000 }] })
    const result = calc.calcPositions([old, s, buy, b2])
    assert.equal(pnl(result), 19433)
    assert.equal(result.holdings['2330'].totalCost, 100000)
})

for (const [label, overrides] of [
    ['跨日期', { date: '2026-08-27' }], ['跨股票', { code: '2454' }], ['跨帳戶', { brokerAccount: 'B' }],
    ['融資', { isMargin: true }], ['零股市場', { tradingSession: 'odd' }], ['鉅額', { tradingSession: 'block' }],
    ['排除當沖', { dayTradeExcluded: true }], ['不足整張', { shares: 999 }],
]) test(`${label}不產生當沖候選，已確認連結亦標記失效`, () => {
    const b = trade({ ...buy, ...overrides })
    const result = calc.analyzeDayTrades([b, sell])
    assert.equal(result.confirmed.length, 0)
    assert.equal(result.candidates.length, 0)
    assert.equal(result.issues.length, 1)
})

test('失效、刪除買入或縮小股數不默默裁切原先確認數量', () => {
    const s = trade({ ...sell, shares: 2000, dayTradeMatches: [{ buyId: 'buy', shares: 2000 }] })
    for (const rows of [[s], [buy, s]]) {
        const result = calc.analyzeDayTrades(rows)
        assert.equal(result.confirmed.length, 0)
        assert.equal(result.issues.length, 1)
    }
})

test('先賣待回補不假造庫存或損益，現金依原始收付', () => {
    const pending = trade({ ...sell, dayTradeMatches: [], dayTradePending: true })
    assert.equal(calc.calcPositions([pending]).realized.length, 0)
    assert.equal(calc.calcAvailableCash([], [pending], []), pending.total)
    assert.equal(validation.validateTradeForWrite(pending).valid, true)
    assert.equal(validation.validateTradeForWrite({ ...pending, isMargin: true }).valid, false)
    assert.equal(validation.validateTradeForWrite(trade({ ...pending, shares: 500 })).valid, false)
    assert.equal(validation.validateTradeForWrite(trade({ ...pending, shares: 1500 })).valid, false)
})

test('分攤保留原始成交金額捨去尾數，全數平倉成本和現金守恆', () => {
    const b = trade({ ...buy, price: 110.12345, shares: 3001, fee: 153 })
    const s = trade({ ...sell, shares: 3001, price: 115.98765, fee: 271, tax: 333, sequence: 3 })
    const result = calc.calcPositions([b, s])
    near(pnl(result), s.total - b.total)
    assert.equal(result.holdings['2330'].shares, 0)
})

test('配股與日末快照使用同一成本，當沖日不改舊持股', () => {
    const divs = [{ date: '2026-08-20', code: '2330', name: '台積電', cashDividend: 0, stockDividend: 100 }]
    const result = calc.calcPositions([old, sell, buy], divs, { includeDailyHoldings: true })
    assert.equal(result.holdings['2330'].shares, 1100)
    near(result.holdings['2330'].avgCost, 100000 / 1100)
    assert.equal(result.dailyHoldings['2026-08-28']['2330'].totalCost, 100000)
    assert.equal(result.dailyHoldings['2026-08-01']['2330'].shares, 1000)
    assert.equal(result.dailyHoldings['2026-08-20']['2330'].shares, 1100)
})

test('現股當沖不動原有融資本金', () => {
    const margin = trade({ ...old, isMargin: true, marginRatio: 0.6 })
    const result = calc.calcPositions([margin, buy, sell])
    assert.equal(result.holdings['2330'].marginAmount, 60000)
    assert.equal(result.holdings['2330'].avgCost, 100)
})

test('已確認先賣後買不被健康中心誤判超賣；待回補及失效會警示', () => {
    const check = trades => health.analyzeDataHealth({ trades, dividends: [], cashflow: [], snapshots: [], notes: [], trash: [] }).issues
    assert.ok(!check([sell, buy]).some(i => i.id === 'oversell'))
    assert.ok(check([{ ...sell, dayTradeMatches: [], dayTradePending: true }]).some(i => i.id === 'daytrade-pending'))
    assert.ok(check([sell]).some(i => i.id === 'daytrade-invalid'))
})

test('CSV 當沖欄位可無損往返，舊 CSV 預設自動', () => {
    const row = { ...sell, brokerAccount: '元大 A', tradingSession: 'regular', dayTradePending: true }
    const fields = csv.importDayTradeFields(csv.exportDayTradeFields(row))
    assert.deepEqual(fields, { brokerAccount: '元大 A', tradingSession: 'regular', dayTradePending: true,
        dayTradeExcluded: false, dayTradeMatches: sell.dayTradeMatches })
    assert.deepEqual(csv.importDayTradeFields({}).dayTradeMatches, [])
    assert.throws(() => csv.importDayTradeFields({ '當沖配對': '{bad' }))
    assert.throws(() => csv.importDayTradeFields({ '當沖配對': '[{"buyId":"buy","shares":-1}]' }))
    const rows = csv.orderTradeImportRows([{ row: { '類型': '賣出' }, sourceIndex: 1 }, { row: { '類型': '買入' }, sourceIndex: 2 }])
    assert.deepEqual(rows.map(r => r.sourceIndex), [2, 1])
})

test('重複連結容量與壞資料驗證，不接受部分無效配對', () => {
    const links = [{ buyId: 'buy', shares: 1000 }, { buyId: 'buy', shares: 1000 }]
    const result = calc.analyzeDayTrades([buy, trade({ ...sell, shares: 2000, dayTradeMatches: links })])
    assert.equal(result.confirmed.length, 0)
    assert.equal(result.issues.length, 1)
    for (const bad of [null, {}, [{ buyId: '', shares: 1000 }], [{ buyId: 'buy', shares: 1 }]]) {
        assert.equal(validation.validateTradeForWrite({ ...sell, dayTradeMatches: bad }).valid, false)
        assert.doesNotThrow(() => calc.analyzeDayTrades([{ ...sell, dayTradeMatches: bad }, buy]))
    }
})

test('自動及人工配對的股數、費稅與成交順序平倉守恆矩陣', () => {
    for (const mode of ['auto', 'manual']) {
    for (const bQty of [1000, 2000, 3000]) for (const sQty of [1000, 2000, 3000]) for (const reverse of [false, true]) {
        const b = trade({ ...buy, shares: bQty, price: 113.45678, fee: 139, sequence: reverse ? 3 : 1 })
        const s = trade({ ...sell, shares: sQty, price: 115.76543, fee: 173, tax: 331, sequence: 2,
            dayTradeMode: mode, dayTradeMatches: mode === 'manual' ? [{ buyId: 'buy', shares: Math.min(bQty, sQty) }] : [] })
        const initial = trade({ ...old, shares: 3000, fee: 91 })
        const result = calc.calcPositions([s, initial, b])
        near(result.holdings['2330'].totalCost, initial.total + b.total - s.total + pnl(result))
        assert.equal(result.holdings['2330'].shares, 3000 + bQty - sQty)
        const liquidation = trade({ id: 'liquidation', date: '2026-08-29', type: 'sell', shares: result.holdings['2330'].shares, price: 120.34567, fee: 159, tax: 301 })
        const final = calc.calcPositions([s, initial, b, liquidation])
        near(pnl(final), s.total + liquidation.total - initial.total - b.total)
    }
    }
})
