import test from 'node:test'
import assert from 'node:assert/strict'
import { readdir } from 'node:fs/promises'
import { invokeEventHandler } from '../netlify/lib/http-function.js'

test('modern request bridge preserves auth, query parameters, Unicode JSON, status and retry headers', async () => {
    const payload = JSON.stringify({ title: '行事曆更新', events: [{ id: 'fixture' }] })
    const request = new Request('https://example.test/api?code=a%2Bb&name=%E5%8F%B0%E7%A9%8D%E9%9B%BB', {
        method: 'POST', headers: { Authorization: 'Bearer fixture', 'Content-Type': 'application/json' }, body: payload,
    })
    const response = await invokeEventHandler(request, async event => {
        assert.equal(event.httpMethod, 'POST')
        assert.equal(event.headers.authorization, 'Bearer fixture')
        assert.deepEqual(event.queryStringParameters, { code: 'a+b', name: '台積電' })
        assert.equal(event.body, payload)
        return { statusCode: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': '60',
            'Cache-Control': 'private, no-store' }, body: JSON.stringify({ error: '請稍後再試' }) }
    })
    assert.equal(response.status, 429)
    assert.equal(response.headers.get('Retry-After'), '60')
    assert.equal(response.headers.get('Cache-Control'), 'private, no-store')
    assert.deepEqual(await response.json(), { error: '請稍後再試' })
})

test('bridge supports empty HTTP responses and HEAD without constructing invalid Response bodies', async () => {
    for (const status of [204, 205, 304]) {
        const response = await invokeEventHandler(new Request('https://example.test'), async () => ({ statusCode: status, body: '' }))
        assert.equal(response.status, status)
        assert.equal(await response.text(), '')
    }
    const response = await invokeEventHandler(new Request('https://example.test', { method: 'HEAD' }), async () => ({ statusCode: 200, body: 'body' }))
    assert.equal(await response.text(), '')
})

test('every deployed entry uses the modern runtime and rejects invalid requests without network access', async t => {
    t.mock.method(globalThis, 'fetch', () => assert.fail('Invalid request must not contact upstream'))
    const files = (await readdir(new URL('../netlify/functions/', import.meta.url))).filter(file => file.endsWith('.js'))
    for (const file of files) {
        const mod = await import(`../netlify/functions/${file}`)
        assert.equal(typeof mod.default, 'function', file)
        assert.equal(mod.handler, undefined, `${file} must not expose a Lambda handler`)
        if (file === 'google-calendar-auth.js') continue
        const calendarPost = ['google-calendar-ensure.js', 'google-calendar-pull.js', 'google-calendar-sync.js'].includes(file)
        const protectedPost = ['fubon-snapshot.js', 'google-calendar-series.js', 'quote-budget.js', 'fugle-proxy.js', 'ai-assistant.js'].includes(file)
        const query = file === 'foreign-quote.js' ? '?symbols=AAPL' : ''
        const request = new Request(`https://example.test/.netlify/functions/${file.slice(0, -3)}${query}`, calendarPost || protectedPost
            ? { method: 'POST', body: '{invalid json' } : {})
        const response = await mod.default(request)
        assert.equal(response.status, file === 'annual-calendars-refresh.js' ? 405 : calendarPost || file === 'google-calendar-series.js' ? 400 : 401, file)
        if (calendarPost) {
            const preflight = await mod.default(new Request(request.url, { method: 'OPTIONS' }))
            assert.equal(preflight.status, 200, file)
            assert.equal(preflight.headers.get('Access-Control-Allow-Methods'), 'POST, OPTIONS', file)
        }
    }
})

test('Google OAuth modern entry rejects unauthenticated starts and unbound callbacks', async t => {
 const originalId=process.env.GOOGLE_CLIENT_ID,originalSecret=process.env.GOOGLE_CLIENT_SECRET
 t.after(()=>{if(originalId===undefined)delete process.env.GOOGLE_CLIENT_ID;else process.env.GOOGLE_CLIENT_ID=originalId;if(originalSecret===undefined)delete process.env.GOOGLE_CLIENT_SECRET;else process.env.GOOGLE_CLIENT_SECRET=originalSecret})
 process.env.GOOGLE_CLIENT_ID='fixture-client';process.env.GOOGLE_CLIENT_SECRET='fixture-secret'
 const {default:auth}=await import('../netlify/functions/google-calendar-auth.js')
 t.mock.method(globalThis,'fetch',()=>assert.fail('Unbound authorization must never exchange codes'))
 const start=await auth(new Request('https://example.test/auth?action=connect',{method:'POST',body:'{}'}))
 assert.equal(start.status,401)
 const finish=await auth(new Request('https://example.test/auth?code=fixture'))
 assert.equal(finish.status,302)
 const destination=new URL(finish.headers.get('Location'))
 assert.equal(destination.pathname,'/calendar/settings')
 assert.match(new URLSearchParams(destination.hash.slice(1)).get('gcal_error'),/驗證失敗/)
 assert.equal(finish.headers.get('Referrer-Policy'),'no-referrer')
 assert.match(finish.headers.get('Set-Cookie'),/Max-Age=0/)
})
