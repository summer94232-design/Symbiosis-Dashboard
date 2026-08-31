import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ts from 'typescript'

const url = code => `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`
const compile = path => ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText
const calcUrl = url(compile('../src/lib/calc.ts'))
const calc = await import(calcUrl)
const presentationUrl = url(compile('../src/lib/dayTradePresentation.ts'))
// Render the real component without authorizing or performing any cloud writes.
const cloudStubUrl = url(`
    const blocked = () => { throw new Error('Cloud calls are forbidden in presentation tests') }
    export const getDocs = blocked, runTransaction = blocked, userCol = blocked, invalidateTrades = blocked, investDB = {};
`)
const componentCode = compile('../src/components/DayTradePanel.tsx')
    .replace(/(['"])react\1/g, JSON.stringify(import.meta.resolve('react')))
    .replace(/(['"])react\/jsx-runtime\1/g, JSON.stringify(import.meta.resolve('react/jsx-runtime')))
    .replace("'../lib/calc'", JSON.stringify(calcUrl))
    .replace("'../lib/dayTradePresentation'", JSON.stringify(presentationUrl))
    .replace("'../ui/styles'", JSON.stringify(url(compile('../src/ui/styles.ts'))))
    .replace(/(['"])(firebase\/firestore|\.\.\/lib\/(firebase|userDB|investData))\1/g, JSON.stringify(cloudStubUrl))
const { default: DayTradePanel } = await import(url(componentCode))
const { getDayTradeAttention } = await import(presentationUrl)
const trade = overrides => {
    const row = { id: 'buy', date: '2026-08-28', type: 'buy', code: '2330', name: '台積電', shares: 1000, price: 100, fee: 0, tax: 0, ...overrides }
    return { ...row, total: calc.calcTradeTotal(row) }
}
const buy = trade({})
const sell = trade({ id: 'sell', type: 'sell', price: 110 })
const render = (trades, props = {}) => renderToStaticMarkup(createElement(DayTradePanel, { trades, onChanged: async () => {}, ...props }))

test('無交易及正常自動沖抵不顯示卡片，計算仍保留當沖結果', () => {
    assert.equal(render([]), '')
    assert.equal(render([buy, sell]), '')
    assert.equal(calc.calcPositions([buy, sell]).realized[0].realized, 10000)
    const manual = { ...sell, dayTradeMode: 'manual', dayTradeMatches: [{ buyId: buy.id, shares: 1000 }] }
    assert.equal(render([buy, manual]), '')
})

test('不明成交類別才提示，卡片不列出無關正常交易', () => {
    const rows = [trade({ shares: 1500 }), sell,
        trade({ id: 'other-buy', code: '2454', name: '正常交易' }),
        trade({ ...sell, id: 'other-sell', code: '2454', name: '正常交易' })]
    const html = render(rows)
    assert.match(html, /當沖交易待核對 · 1 筆/)
    assert.match(html, /混合股數/)
    assert.doesNotMatch(html, /正常交易/)
})

test('待回補與失效配對會提示，補齊回補後自動隱藏', () => {
    const pending = { ...sell, dayTradePending: true }
    assert.match(render([pending]), /待回補尚未完全沖抵/)
    assert.equal(render([buy, pending]), '')
    const invalid = { ...sell, dayTradeMatches: [{ buyId: 'missing', shares: 1000 }] }
    assert.match(render([invalid]), /當沖配對失效/)
})

test('同筆多項異常只計一次，主動開啟仍能查看及修正正常配對', () => {
    const invalidPending = { ...sell, dayTradePending: true, dayTradeMatches: [{ buyId: 'missing', shares: 1000 }] }
    assert.equal(getDayTradeAttention([invalidPending], calc.analyzeDayTrades([invalidPending])).count, 1)
    const html = render([buy, sell], { showDetails: true, onClose: () => {} })
    assert.match(html, /當日沖銷明細/)
    assert.match(html, /修正股數/)
    assert.match(html, /關閉明細/)
})

test('新增及編輯表單不再渲染常駐當沖判定提示', () => {
    const source = readFileSync(new URL('../src/pages/invest/Trades.tsx', import.meta.url), 'utf8')
    assert.doesNotMatch(source, /TradeDayTradeDetails|當沖判定/)
    assert.match(source, /showDetails=\{showDayTradeDetails\}/)
})
