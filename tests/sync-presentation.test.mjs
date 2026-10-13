import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import { compile, read } from './helpers/compile.mjs'

const require = createRequire(import.meta.url)
const { formatSyncTime } = compile(read('src/lib/syncPresentation.ts'))

test('compact sync time uses the Taipei calendar day and retains the date for older updates', () => {
    const now = new Date('2026-09-30T16:10:00Z')
    assert.equal(formatSyncTime('2026-09-30T16:01:00Z', now).short, '00:01')
    assert.match(formatSyncTime('2026-09-30T15:59:00Z', now).short, /2026-09-30 23:59/)
    assert.match(formatSyncTime('2025-12-31T15:59:00Z', now).short, /2025-12-31 23:59/)
    assert.match(formatSyncTime('2026-09-30T16:01:00Z', now).full, /2026\/10\/1\s00:01:00/)
})

test('invalid or old localized sync values never become a fabricated timestamp', () => {
    for (const value of ['', 'invalid', '2026/9/30 下午8:40', '2026-09-30Tbroken']) assert.equal(formatSyncTime(value), null)
})

test('sync presentation keeps errors and previous-success meaning while hiding the internal counter', () => {
    const DisclosureNote = compile(read('src/components/DisclosureNote.tsx'), { require, ChevronRight: require('lucide-react').ChevronRight }).default
    for (const status of ['live', 'error', 'connecting']) {
        const value = { status, version: 47, lastSyncedAt: '2026-09-30T12:40:00Z', changedCollection: '買賣紀錄' }
        const mod = compile(read('src/InvestSyncContext.tsx'), {
            require, DisclosureNote, createContext: () => ({}), useContext: () => value,
            formatSyncTime: timestamp => formatSyncTime(timestamp, new Date('2026-09-30T13:00:00Z')),
        })
        const markup = renderToStaticMarkup(createElement(mod.InvestSyncStatus))
        assert.ok(!markup.includes('v47'))
        assert.ok(markup.includes(status === 'live' ? '已同步 · 20:40' : status === 'error' ? '同步異常 · 上次 20:40' : '連線中 · 上次 20:40'))
        assert.ok(markup.includes('最後同步：')); assert.ok(markup.includes('最近更新：'))
        assert.ok(!markup.includes('<details open'))
    }
})
