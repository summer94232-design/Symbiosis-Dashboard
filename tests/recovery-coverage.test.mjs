import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { Component } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { compile, read } from './helpers/compile.mjs'

const calc = compile(read('src/lib/calc.ts'))
const calendar = compile(read('src/lib/calendarData.ts'))
const dates = compile(read('src/lib/date.ts'))
const coverage = compile(read('src/lib/annualDataCoverage.ts'), { ...calc, ...calendar, ...dates })
const range = (start, end = start) => ({ start, end })

test('covered FOMC year stays quiet even when a month has no meeting', () => {
    assert.deepEqual(coverage.getAnnualDataWarnings({ fomcRange: range('2026-02-01', '2026-02-28') }), [])
    assert.deepEqual(coverage.getAnnualDataWarnings({ fomcRange: range('2025-01-01', '2026-12-31') }), [])
})
test('missing FOMC year is distinguished from an empty event list', () => {
    assert.match(coverage.getAnnualDataWarnings({ fomcRange: range('2027-01-01', '2027-12-31') })[0], /2027 年 FOMC.*不完整/)
    assert.deepEqual(coverage.getAnnualDataWarnings({}), [])
})
test('date ranges report missing years inside the range, not only its endpoints', () => {
    assert.deepEqual(coverage.missingAnnualYears(range('2025-12-31', '2028-01-01'), [2025, 2028]), [2026, 2027])
    assert.deepEqual(coverage.missingAnnualYears(range('2026-02-30', '2027-01-01'), []), [])
    assert.deepEqual(coverage.missingAnnualYears(range('2027-01-01', '2026-01-01'), []), [])
})
test('14-day New Year horizon identifies the following FOMC year', () => {
    assert.match(coverage.getAnnualDataWarnings({ fomcRange: range('2026-12-25', '2027-01-08') })[0], /2027/)
})
test('Google six-month sync warns for next year while a fully covered horizon stays quiet', () => {
    const complete = coverage.googleSyncDateRange(new Date(2026, 0, 15))
    assert.deepEqual(complete, range('2026-01-15', '2026-07-15'))
    assert.deepEqual(coverage.getAnnualDataWarnings({ fomcRange: complete }), [])
    const incomplete = coverage.googleSyncDateRange(new Date(2026, 8, 30))
    assert.deepEqual(incomplete, range('2026-09-30', '2027-03-30'))
    assert.match(coverage.getAnnualDataWarnings({ fomcRange: incomplete })[0], /2027/)
})
test('ordinary 2026 settlement estimates stay quiet', () => {
    assert.deepEqual(coverage.getAnnualDataWarnings({ settlementRange: range('2026-01-15', '2026-09-30') }), [])
})
test('T+2 from a December trade entering next year warns before the calendar year changes', () => {
    assert.deepEqual(calc.getSettlementCalendarYears('2026-12-30', '2026-12-30'), [2026, 2027])
    assert.match(coverage.getAnnualDataWarnings({ settlementRange: range('2026-12-30') })[0], /2027.*交割休假.*估算.*券商/)
    assert.deepEqual(calc.getSettlementCalendarYears('2026-12-23', '2026-12-23'), [2026])
})
test('past unsupported settlement years and multi-year interest ranges also warn', () => {
    assert.match(coverage.getAnnualDataWarnings({ settlementRange: range('2025-12-01', '2027-01-15') })[0], /2025、2027/)
    assert.deepEqual(calc.getSettlementCalendarYears('wrong', '2027-01-15'), [])
    assert.deepEqual(calc.getSettlementCalendarYears('2026-02-30', '2027-01-15'), [])
})

const require = createRequire(import.meta.url)
const { default: Notice } = compile(read('src/components/AnnualDataNotice.tsx'), { ...coverage, require })
test('annual notices render only relevant warnings and remain absent for covered data', () => {
    assert.equal(renderToStaticMarkup(Notice({ fomcRange: range('2026-01-01') })), '')
    const html = renderToStaticMarkup(Notice({ fomcRange: range('2027-01-01'), settlementRange: range('2026-12-30') }))
    assert.match(html, /role="status"/)
    assert.match(html, /FOMC 日期/)
    assert.match(html, /交割休假/)
})
const { default: Boundary } = compile(read('src/components/AppErrorBoundary.tsx'), { Component, require })
test('recovery fallback offers reload and dashboard without exposing error details', () => {
    const boundary = new Boundary({ children: 'healthy', scope: 'page' })
    assert.equal(boundary.render(), 'healthy')
    boundary.state = Boundary.getDerivedStateFromError(Error('private diagnostic fixture'))
    const html = renderToStaticMarkup(boundary.render())
    assert.match(html, /role="alert"/)
    assert.match(html, /重新載入/)
    assert.match(html, /href="\/invest"/)
    assert.match(html, /側欄/)
    assert.doesNotMatch(html, /private diagnostic fixture/)
})
test('outer recovery fallback also works without a router or theme provider', () => {
    const boundary = new Boundary({ children: 'healthy' })
    boundary.state = { failed: true }
    assert.match(renderToStaticMarkup(boundary.render()), /系統暫時無法顯示/)
})
