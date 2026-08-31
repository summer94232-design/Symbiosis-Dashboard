import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ts from 'typescript'

const compile = path => ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText
const url = code => `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`
const listUrl = url(compile('../src/lib/tradeList.ts'))
const { compareTradeListRecords: compare, getTradeDayTradeBadge: badge } = await import(listUrl)
const calc = await import(url(compile('../src/lib/calc.ts')))
const { default: Badge } = await import(url(compile('../src/components/TradeDayTradeBadge.tsx')
    .replace(/(['"])react\/jsx-runtime\1/g, JSON.stringify(import.meta.resolve('react/jsx-runtime')))
    .replace("'../lib/tradeList'", JSON.stringify(listUrl))))
const trade = overrides => {
    const row = { id: 'buy', date: '2026-08-28', type: 'buy', code: '2330', name: '台積電', price: 100, shares: 1000, fee: 0, tax: 0, ...overrides }
    return { ...row, total: calc.calcTradeTotal(row) }
}
const ids = rows => [...rows].sort(compare).map(row => row.id)

test('列表依日期降冪、股票代號數值升冪、同股新增時間降冪', () => {
    const rows = [
        trade({ id: 'stock-early', createdAt: '2026-08-28T09:00:00+08:00' }),
        trade({ id: 'old-date', date: '2026-08-27', code: '0050', createdAt: '2026-08-29T12:00:00+08:00' }),
        trade({ id: 'etf-late', code: '0050', createdAt: '2026-08-28T11:00:00+08:00' }),
        trade({ id: 'stock-late', createdAt: '2026-08-28T13:00:00+08:00' }),
        trade({ id: 'etf-early', code: '0050', createdAt: '2026-08-28T10:00:00+08:00' }),
        trade({ id: 'leveraged', code: '00631L' }),
    ]
    assert.deepEqual(ids(rows), ['etf-late', 'etf-early', 'leveraged', 'stock-late', 'stock-early', 'old-date'])
})

test('新增時間使用實際時間戳排序，支援不同時區格式', () => {
    assert.deepEqual(ids([
        trade({ id: 'earlier', createdAt: '2026-08-28T13:00:00+08:00' }),
        trade({ id: 'later', createdAt: '2026-08-28T06:00:00Z' }),
    ]), ['later', 'earlier'])
})

test('缺新增時間的舊資料排在已知時間後，依既有順序及 ID 穩定排列', () => {
    assert.deepEqual(ids([
        trade({ id: 'a' }), trade({ id: 'b', createdAt: 'invalid' }),
        trade({ id: 'seq1', sequence: 1 }), trade({ id: 'seq2', sequence: 2 }),
        trade({ id: 'timed', createdAt: '2026-08-28T01:00:00Z' }),
    ]), ['timed', 'seq2', 'seq1', 'b', 'a'])
})

test('相同時間採來源順序，排序具對稱性且不受讀取順序影響', () => {
    const rows = [1, 3, 2].map(sequence => trade({ id: String(sequence), sequence, createdAt: '2026-08-28T01:00:00Z' }))
    assert.deepEqual(ids(rows), ['3', '2', '1'])
    assert.deepEqual(ids([...rows].reverse()), ids(rows))
    for (const a of rows) for (const b of rows) {
        assert.equal(compare(a, b) === 0, compare(b, a) === 0)
        if (a !== b) assert.equal(Math.sign(compare(a, b)), -Math.sign(compare(b, a)))
    }
})

test('自動配對買賣兩側皆有標籤，部分沖抵標示股數且保留一般庫存', () => {
    const buy = trade({ shares: 2000 })
    const sell = trade({ id: 'sell', type: 'sell', price: 110 })
    const analysis = calc.analyzeDayTrades([buy, sell], false)
    assert.equal(badge(buy.shares, analysis.matchedShares.get(buy)).label, '部分當沖')
    assert.equal(badge(sell.shares, analysis.matchedShares.get(sell)).label, '當沖')
    const html = renderToStaticMarkup(createElement(Badge, { shares: buy.shares, matchedShares: analysis.matchedShares.get(buy) }))
    assert.match(html, />部分當沖<\/span>/)
    assert.match(html, /沖抵 1,000 股/)
    assert.match(html, /其餘 1,000 股/)
})

test('零股、融資、排除及僅候選交易不標示當沖', () => {
    for (const overrides of [{ shares: 500 }, { isMargin: true }, { dayTradeExcluded: true }, { shares: 1500 }]) {
        const buy = trade(overrides)
        const sell = trade({ id: 'sell', type: 'sell', ...overrides })
        const analysis = calc.analyzeDayTrades([buy, sell])
        assert.equal(badge(sell.shares, analysis.matchedShares.get(sell) || 0), null)
    }
    assert.equal(renderToStaticMarkup(createElement(Badge, { shares: 1000, matchedShares: 0 })), '')
})

test('有效人工配對有當沖標籤，失效連結與異常數量不顯示', () => {
    const buy = trade({})
    const sell = trade({ id: 'sell', type: 'sell', dayTradeMatches: [{ buyId: 'buy', shares: 1000 }] })
    const analysis = calc.analyzeDayTrades([buy, sell])
    assert.equal(badge(sell.shares, analysis.matchedShares.get(sell)).label, '當沖')
    assert.equal(badge(sell.shares, calc.analyzeDayTrades([sell]).matchedShares.get(sell) || 0), null)
    for (const qty of [NaN, Infinity, -1000, 0]) assert.equal(badge(1000, qty), null)
})

test('列表排序不修改原始陣列或成本結果，搜尋後仍能沿用完整配對數量', () => {
    const rows = [trade({ id: 'old', date: '2026-08-01', price: 90 }), trade({}),
        trade({ id: 'sell', type: 'sell', price: 110, createdAt: '2026-08-28T06:00:00Z' })]
    const original = structuredClone(rows)
    const analysis = calc.analyzeDayTrades(rows, false)
    const sorted = rows.filter(() => true).sort(compare)
    assert.deepEqual(rows, original)
    assert.deepEqual(calc.calcPositions(sorted), calc.calcPositions(rows))
    assert.equal(analysis.matchedShares.get(sorted.find(t => t.id === 'sell')), 1000)
})
