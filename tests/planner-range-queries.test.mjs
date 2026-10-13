import test from 'node:test'
import assert from 'node:assert/strict'
import { compile, read } from './helpers/compile.mjs'

const docsFrom = rows => ({ docs: rows.map(({ id, ...data }) => ({ id, data: () => data })) })

function harness(rows) {
    const { cache } = compile(read('src/lib/cache.ts'))
    const reads = []
    const apply = (rowsIn, q) => {
        let out = rowsIn
        for (const c of q.constraints) {
            if (c.kind === 'where' && c.op === '>=') out = out.filter(r => typeof r[c.field] === 'string' && r[c.field] >= c.value)
            if (c.kind === 'where' && c.op === '<=') out = out.filter(r => typeof r[c.field] === 'string' && r[c.field] <= c.value)
            if (c.kind === 'where' && c.op === '==') out = out.filter(r => r[c.field] === c.value)
            if (c.kind === 'orderBy') out = out.filter(r => r[c.field] !== undefined).sort((a, b) => a[c.field] < b[c.field] ? -1 : a[c.field] > b[c.field] ? 1 : 0)
        }
        return out
    }
    const mod = compile(read('src/lib/plannerData.ts'), {
        investDB: 'db', cache,
        captureUserSession: () => ({ uid: 'u1', assertActive() {}, col: (_db, name) => ({ name }) }),
        where: (field, op, value) => ({ kind: 'where', field, op, value }),
        orderBy: (field, dir) => ({ kind: 'orderBy', field, dir }),
        query: (col, ...constraints) => ({ col, constraints }),
        getDocs: async q => { reads.push(q); return docsFrom(apply(rows[q.col.name], q)) },
    })
    return { ...mod, reads, cache }
}

const events = [
    { id: 'old', date: '2025-01-01' },
    { id: 'longOngoing', date: '2026-08-01', start: { date: '2026-08-01' }, end: { date: '2026-12-01' } },
    { id: 'today', date: '2026-10-13' },
    { id: 'in14', date: '2026-10-27' },
    { id: 'after', date: '2026-10-28' },
]
const tasks = [
    { id: 'b', done: false, order: 2 }, { id: 'done', done: true, order: 0 },
    { id: 'a', done: false, order: 1 }, { id: 'noOrder', done: false },
]

test('range query bounds the server read and keeps ongoing multi-day events', async () => {
    const h = harness({ calendarEvents: events, tasks })
    const rows = await h.fetchCalendarEventsInRange('2026-10-13', '2026-10-27')
    assert.deepEqual(rows.map(r => r.id), ['longOngoing', 'today', 'in14'])
    const [q] = h.reads
    assert.deepEqual(q.constraints.filter(c => c.kind === 'where').map(c => [c.field, c.op, c.value]),
        [['date', '>=', '2026-04-16'], ['date', '<=', '2026-10-27']])
    await h.fetchCalendarEventsInRange('2026-10-13', '2026-10-27')
    assert.equal(h.reads.length, 1, 'second call is served from cache')
    assert.equal(h.PLANNER_EVENT_LOOKBACK_DAYS, 180)
    await assert.rejects(h.fetchCalendarEventsInRange('2026/10/13', '2026-10-27'))
})

test('open tasks read only done == false and keep the fetchTasks order and set', async () => {
    const h = harness({ calendarEvents: events, tasks })
    const open = await h.fetchOpenTasks()
    assert.deepEqual(open.map(t => t.id), ['a', 'b'])
    assert.deepEqual(h.reads[0].constraints.map(c => [c.kind, c.field, c.op, c.value]), [['where', 'done', '==', false]])
    const all = await h.fetchTasks()
    assert.deepEqual(all.filter(t => !t.done).map(t => t.id), open.map(t => t.id))
})

test('subset reads reuse a cached full collection and are cleared by invalidation', async () => {
    const h = harness({ calendarEvents: events, tasks })
    await h.fetchCalendarEvents()
    await h.fetchTasks()
    assert.equal(h.reads.length, 2)
    assert.deepEqual((await h.fetchCalendarEventsInRange('2026-10-13', '2026-10-27')).map(r => r.id), ['longOngoing', 'today', 'in14'])
    assert.deepEqual((await h.fetchOpenTasks()).map(t => t.id), ['a', 'b'])
    assert.equal(h.reads.length, 2, 'no extra Firestore reads when the full list is cached')

    const fresh = harness({ calendarEvents: events, tasks })
    await fresh.fetchOpenTasks()
    tasks.push({ id: 'c', done: false, order: 3 })
    fresh.invalidateTasks()
    assert.deepEqual((await fresh.fetchOpenTasks()).map(t => t.id), ['a', 'b', 'c'])
    assert.equal(fresh.reads.length, 2, 'invalidateTasks clears the open-task subset')
    tasks.pop()
})

test('returned rows are copies, so callers cannot mutate the cache', async () => {
    const h = harness({ calendarEvents: events, tasks })
    const [first] = await h.fetchOpenTasks()
    first.title = 'mutated'
    const [again] = await h.fetchOpenTasks()
    assert.equal(again.title, undefined)
})
