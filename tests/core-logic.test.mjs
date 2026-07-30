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
const taskOrder = await importTypeScriptModule('../src/lib/taskOrder.ts')
const { cache } = await importTypeScriptModule('../src/lib/cache.ts')
const dataHealth = await importTypeScriptModule('../src/lib/dataHealth.ts')
const investorMeetingMerge = await importTypeScriptModule('../src/lib/investorMeetingMerge.ts')

const trade = (overrides) => ({
    id: '', date: '2026-07-23', type: 'buy', code: '2330', name: '台積電',
    price: 100, shares: 100, fee: 0, tax: 0, total: 10000,
    ...overrides,
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
