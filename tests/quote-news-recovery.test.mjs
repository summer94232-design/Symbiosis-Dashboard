import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { generateKeyPairSync, verify, createHash } from 'node:crypto'
import { cert, initializeApp, deleteApp } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'
import { createMeetingsCredential } from '../netlify/lib/meetings-credential.js'
import ts from 'typescript'
import { compile, read } from './helpers/compile.mjs'
const { buttonFill } = compile(read('src/ui/styles.ts'))
const quoteTiming = compile(read('src/lib/quoteTiming.ts'))

const policy = compile(read('src/lib/pricePolicy.ts'), { toLocalDateString: () => '2026-09-18' })
function quotesHarness(fetcher, budgeter) {
    let time = Date.parse('2026-09-18T01:00:00Z')
    const starts = [], budgetRequests = []
    class Clock extends Date {
        constructor(...args) { super(...(args.length ? args : [time])) }
        static now() { return time }
    }
    const mod = compile(read('src/lib/fugle.ts').replace('import.meta.env.VITE_FUGLE_API_KEY', "'test-key'"), {
        ...policy, ...quoteTiming, Date: Clock,
        captureUserSession: () => ({ assertActive() {} }),
        authenticatedFetch: async (_, __, options) => {
            const input = JSON.parse(options.body)
            assert.ok(options.signal)
            assert.equal(options.headers['X-API-KEY'], undefined, 'client never sends a provider key')
            budgetRequests.push(1)
            let budget
            try { budget = budgeter ? await budgeter(1) : {granted:1,retryAfter:0} }
            catch { return {ok:false,status:503,json:async()=>({error:'budget unavailable'})} }
            if (!budget.granted) return {ok:false,status:429,headers:{get:()=>String(budget.retryAfter)},json:async()=>({error:'budget denied'})}
            const url = 'https://api.fugle.tw/marketdata/v1.0/stock/' + (input.kind==='history'?'historical/candles/':'intraday/quote/') + input.symbol
            starts.push({symbol:input.symbol,time})
            return fetcher(url,starts.length,options)
        },
        setTimeout: (fn, delay) => { time += delay; queueMicrotask(fn) },
        fetch: async (url, options) => {
            starts.push({ symbol: url.split('/').at(-1), time })
            assert.ok(options.signal)
            return fetcher(url, starts.length, options)
        },
    })
    return { ...mod, starts, budgetRequests, advance: ms => { time += ms } }
}
const okQuote = (data = {}) => ({ ok: true, status: 200, json: async () => ({ date: '2026-09-18', closePrice: 120, lastUpdated: 123, ...data }) })

const meetingKeys = generateKeyPairSync('rsa', { modulusLength: 2048 })
const meetingAccount = { project_id: 'fixture-project', client_email: 'fixture@fixture-project.iam.gserviceaccount.com',
    private_key: meetingKeys.privateKey.export({ type: 'pkcs8', format: 'pem' }), type: 'service_account' }

test('meetings uses a valid RS256 Google token exchange without mutating the shared news certificate', async t => {
    const original = cert(meetingAccount), originalMethod = original.getAccessToken
    let calls = 0
    t.mock.method(globalThis, 'fetch', async (url, options) => {
        calls++
        assert.equal(url, 'https://oauth2.googleapis.com/token')
        assert.equal(options.method, 'POST')
        assert.equal(options.redirect, 'error')
        assert.ok(options.signal)
        assert.equal(options.body.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer')
        const [header, claims, signature] = options.body.get('assertion').split('.')
        assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url')), { alg: 'RS256', typ: 'JWT' })
        assert.ok(verify('RSA-SHA256', Buffer.from(`${header}.${claims}`), meetingKeys.publicKey, Buffer.from(signature, 'base64url')))
        const payload = JSON.parse(Buffer.from(claims, 'base64url'))
        assert.equal(payload.iss, meetingAccount.client_email)
        assert.equal(payload.aud, url)
        assert.equal(payload.scope, 'https://www.googleapis.com/auth/identitytoolkit')
        assert.equal(payload.exp - payload.iat, 3600)
        assert.ok(Math.abs(payload.iat - Date.now() / 1000) < 5)
        assert.equal(payload.sub, undefined)
        return new Response(JSON.stringify({ access_token: 'fixture-access-token', expires_in: 3600, token_type: 'Bearer' }))
    })
    const credential = createMeetingsCredential(meetingAccount)
    assert.notEqual(credential, original)
    assert.equal(original.getAccessToken, originalMethod)
    assert.equal(credential instanceof original.constructor, true)
    assert.equal(credential.projectId, meetingAccount.project_id)
    const app = initializeApp({ credential, projectId: meetingAccount.project_id }, 'meetings-credential-fixture')
    const db = getFirestore(app)
    try {
        const [one, two] = await Promise.all([app.INTERNAL.getToken(), app.INTERNAL.getToken()])
        assert.equal(one.accessToken, 'fixture-access-token')
        assert.equal(two.accessToken, 'fixture-access-token')
        await app.INTERNAL.getToken()
        assert.equal(calls, 1, 'Firebase caches the successful credential token')
        assert.equal(db.projectId, meetingAccount.project_id)
    } finally { await db.terminate(); await deleteApp(app) }
})

test('meetings credential rejects provider failures safely and permits a later retry', async t => {
    let calls = 0
    t.mock.method(globalThis, 'fetch', async () => {
        calls++
        if (calls === 1) return new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'Invalid JWT Signature. secret-canary' }), { status: 400 })
        return new Response(JSON.stringify({ access_token: 'fixture-access-token', expires_in: 3600, token_type: 'Bearer' }))
    })
    const credential = createMeetingsCredential(meetingAccount)
    const { authenticationDiagnostic } = compile(read('netlify/lib/api-access.js'))
    await assert.rejects(credential.getAccessToken(), error => {
        assert.deepEqual(authenticationDiagnostic({ code: 'app/invalid-credential', cause: error }), { code: 'app/invalid-credential', reason: 'jwt-signature-invalid' })
        assert.ok(!JSON.stringify(error).includes('secret-canary'))
        assert.ok(!error.message.includes('secret-canary'))
        return true
    })
    assert.equal((await credential.getAccessToken()).access_token, 'fixture-access-token')
    assert.equal(calls, 2)
})

test('meetings credential rejects malformed token responses and connection failures', async t => {
    const cases = [
        () => { throw new Error('secret-network-error') },
        () => new Response('<html>secret</html>'),
        () => new Response(JSON.stringify({ access_token: '', expires_in: 3600, token_type: 'Bearer' })),
        () => new Response(JSON.stringify({ access_token: 'fixture', expires_in: '3600', token_type: 'Bearer' })),
        () => new Response(JSON.stringify({ access_token: 'fixture', expires_in: 3600, token_type: 42 })),
        () => new Response(JSON.stringify({ access_token: 'fixture', expires_in: -1, token_type: 'Bearer' })),
        () => new Response(JSON.stringify({ error: 'secret-code', error_description: 'secret-body' }), { status: 503 }),
    ]
    let response
    t.mock.method(globalThis, 'fetch', async () => response())
    for (const item of cases) {
        response = item
        await assert.rejects(createMeetingsCredential(meetingAccount).getAccessToken(), error => {
            assert.equal(error.code, 'app/invalid-credential')
            assert.ok(!JSON.stringify(error).includes('secret'))
            return true
        })
    }
})

test('meetings and Fubon snapshots use isolated credentials with revocation, allowlist and quota', async () => {
    let selected = 0, plain = 0, user = 'allowed', authError = null, quotaCalls = 0
    const apps = [], writes = []
    const mod = compile(read('netlify/lib/api-access.js'), {
        createHash,
        process: { env: { API_FIREBASE_PROJECT_ID: 'fixture', API_FIREBASE_SERVICE_ACCOUNT: '{"project_id":"fixture"}', API_ALLOWED_UIDS: 'allowed' } },
        getApps: () => apps,
        cert: () => { plain++; return { mode: 'original' } },
        createMeetingsCredential: () => { selected++; return { mode: 'meetings' } },
        initializeApp: (options, name) => { const app = { options, name }; apps.push(app); return app },
        getAuth: app => ({ verifyIdToken: async (_token, revoked) => {
            assert.equal(revoked, true)
            assert.equal(app.options.credential.mode, app.name === 'protected-meetings-api' ? 'meetings' : 'original')
            if (authError) throw authError
            return { uid: user }
        } }),
        getFirestore: () => ({ doc: path => path, runTransaction: async fn => { quotaCalls++; return fn({ get: async () => ({ data: () => ({}) }), set: (...args) => writes.push(args) }) } }),
    })
    const event = { httpMethod: 'GET', headers: { authorization: 'Bearer fixture' } }
    assert.equal(await mod.authorizeApi(event, 'meetings'), null)
    assert.equal(selected, 1)
    assert.equal(plain, 0)
    assert.equal(quotaCalls, 1)
    assert.equal(writes.length, 2)
    const snapshotEvent = { ...event, httpMethod: 'POST' }
    assert.equal(await mod.authorizeApi(snapshotEvent, 'fubonSnapshot', 1, 'POST'), null)
    assert.equal(selected, 1)
    assert.equal(plain, 0)
    assert.equal(quotaCalls, 2)
    authError = { code: 'auth/id-token-revoked' }
    assert.equal((await mod.authorizeApi(snapshotEvent, 'fubonSnapshot', 1, 'POST')).statusCode, 401)
    authError = null; user = 'not-allowed'
    assert.equal((await mod.authorizeApi(snapshotEvent, 'fubonSnapshot', 1, 'POST')).statusCode, 403)
    assert.equal(quotaCalls, 2)
    user = 'allowed'
    assert.equal(await mod.authorizeApi(event, 'news'), null)
    assert.equal(plain, 1)
    assert.equal(selected, 1)
})

test('reauthorization preserves the calendar and selected sync types', async () => {
    const saved = { calendarId: 'existing-calendar', syncTypes: ['personal'], refreshToken: 'old' }
    const mod = compile(read('src/lib/googleCalendar.ts'), {
        investDB: {}, captureUserSession: () => ({ doc: () => 'auth', assertActive() {} }),
        runTransaction: async (_db, callback) => callback({
            get: async () => ({ exists: () => true, data: () => saved }),
            set: (_ref, data, options) => { assert.equal(options.merge, true); Object.assign(saved, data) },
        }),
    })
    await mod.saveGoogleCalendarAuth('new')
    assert.equal(saved.refreshToken, 'new')
    assert.equal(saved.calendarId, 'existing-calendar')
    assert.deepEqual(saved.syncTypes, ['personal'])
})

test('historical request is bounded and a later attempt can recover from network failure', async () => {
    let count = 0
    const h = quotesHarness(() => {
        if (++count === 1) throw new Error('network unavailable')
        return { ok: true, json: async () => ({ data: [] }) }
    })
    assert.deepEqual(await h.getHistoricalCandles('2330', '2026-09-01', '2026-09-18'), { data: [] })
    assert.equal(count, 2)
})

test('history batches share the quote budget and merge identical pending requests', async () => {
    let active = 0, peak = 0
    const h = quotesHarness(async () => {
        peak = Math.max(peak, ++active)
        await settle()
        active--
        return { ok: true, status: 200, json: async () => ({ data: [] }) }
    })
    const first = h.getHistoricalCandles('2330', '2026-09-01', '2026-09-18')
    assert.equal(first, h.getHistoricalCandles('2330', '2026-09-01', '2026-09-18'))
    await Promise.all([first, ...Array.from({ length: 65 }, (_, i) => h.getHistoricalCandles(String(1000 + i), '2026-09-01', '2026-09-18'))])
    assert.equal(h.starts.length, 66)
    assert.ok(peak <= 4)
    for (const start of h.starts) assert.ok(h.starts.filter(s => s.time >= start.time && s.time < start.time + 61000).length <= 55)
    // Quote calls must also respect the slots already consumed by history.
    await h.getMultipleQuoteObservations(Array.from({ length: 50 }, (_, i) => String(3000 + i)), 'now')
    for (const start of h.starts) assert.ok(h.starts.filter(s => s.time >= start.time && s.time < start.time + 61000).length <= 55)
})

test('history honors Retry-After, bounds retries and reports permanent failures distinctly', async () => {
    for (const header of ['60', null, 'invalid']) {
        const h = quotesHarness((_, call) => call === 1
            ? { ok: false, status: 429, headers: { get: () => header } }
            : { ok: true, status: 200, json: async () => ({ data: [] }) })
        await h.getHistoricalCandles('2330', '2026-09-01', '2026-09-18')
        assert.equal(h.starts.length, 2)
        assert.ok(h.starts[1].time - h.starts[0].time >= (header === '60' ? 60000 : 61000))
    }
    for (const status of [401, 403, 404, 500, 429]) {
        const h = quotesHarness(() => ({ ok: false, status, headers: { get: () => null } }))
        await assert.rejects(h.getHistoricalCandles('2330', '2026-09-01', '2026-09-18'), /歷史行情/)
        assert.equal(h.starts.length, status >= 500 || status === 429 ? 2 : 1)
    }
    const daily = quotesHarness(() => ({ ok: false, status: 429, headers: { get: () => '86400' } }))
    await assert.rejects(daily.getHistoricalCandles('2330', '2026-09-01', '2026-09-18'), /額度已用完/)
    assert.equal(daily.starts.length, 1)
})

test('history validates response, sorts candles, and releases failed requests for manual retry', async () => {
    const bad = quotesHarness(() => ({ ok: true, status: 200, json: async () => ({ error: 'invalid' }) }))
    await assert.rejects(bad.getHistoricalCandles('2330', '2026-09-01', '2026-09-18'), /資料格式/)
    await assert.rejects(bad.getHistoricalCandles('2330', '2026-09-01', '2026-09-18'), /資料格式/)
    assert.equal(bad.starts.length, 2)
    const timeout = quotesHarness(() => { throw new Error('timeout') })
    await assert.rejects(timeout.getHistoricalCandles('2330', '2026-09-01', '2026-09-18'), /逾時/)
    assert.equal(timeout.starts.length, 2)
    const absent = compile(read('src/lib/fugle.ts'), {
        ...policy, ...quoteTiming, captureUserSession: () => ({assertActive(){}}),
        authenticatedFetch: async () => ({ok:false,status:503}),
    })
    await assert.rejects(absent.getHistoricalCandles('2330', '2026-09-01', '2026-09-18'), /HTTP 503/)
    const sorted = quotesHarness(() => ({ ok: true, status: 200, json: async () => ({ data: ['2026-09-18', '2026-09-17'].map(date => ({ date, open: 100, high: 110, low: 90, close: 105 })) }) }))
    assert.deepEqual((await sorted.getHistoricalCandles('2330', '2026-09-01', '2026-09-18')).data.map(b => b.date), ['2026-09-17', '2026-09-18'])
})

test('watchlist history worker pool limits concurrency and processes every item', async () => {
    const mod = compile(read('src/pages/invest/Watchlist.tsx'), { require: createRequire(import.meta.url) }, 'export { forEachHistoryItem }')
    let active = 0, peak = 0
    const completed = []
    await mod.forEachHistoryItem(Array.from({ length: 19 }, (_, i) => i), async item => {
        peak = Math.max(peak, ++active)
        await settle()
        completed.push(item)
        active--
    })
    assert.equal(peak, 3)
    assert.equal(new Set(completed).size, 19)
})

test('watchlist MA and chart updates distinguish empty data from failure and always release loading', async () => {
    const source = read('src/pages/invest/Watchlist.tsx')
    const worker = compile(source, { require: createRequire(import.meta.url) }, 'export { forEachHistoryItem }').forEachHistoryItem
    for (const kind of ['MA', 'Chart']) {
        const start = source.indexOf(`    const handleUpdate${kind} = async () => {`)
        const end = source.indexOf('\n    // ★', start)
        let issues = [], result, loading
        const busy = { current: { ma: false, chart: false } }
        const mod = compile(source.slice(start, end), {
            items: ['ok', 'empty', 'failed'].map(code => ({ code, market: 'tw' })),
            historyBusy: busy, forEachHistoryItem: worker,
            toLocalDateString: () => '2026-09-18',
            calcMA: (closes, n) => closes.length >= n ? closes.slice(-n).reduce((a, b) => a + b) / n : null,
            getHistoricalCandles: async code => {
                if (code === 'failed') throw new Error('歷史行情服務限流，請稍後重試')
                return { data: code === 'empty' ? [] : Array.from({ length: 20 }, (_, i) => ({ date: `2026-09-${String(i + 1).padStart(2, '0')}`, close: 100, volume: 1 })) }
            },
            setMaLoading: value => { loading = value }, setChartLoading: value => { loading = value },
            setMaIssues: value => { issues = value }, setChartIssues: value => { issues = value },
            setMaData: value => { result = value }, setChartData: value => { result = value },
        }, `export { handleUpdate${kind} }`)
        await mod[`handleUpdate${kind}`]()
        assert.ok(issues.includes('empty：此期間無歷史資料'))
        assert.ok(issues.some(message => message.startsWith('failed：') && message.includes('限流')))
        assert.equal(loading, false)
        assert.equal(busy.current[kind === 'MA' ? 'ma' : 'chart'], false)
        if (kind === 'MA') assert.equal(result.ok.ma20, 100)
        else assert.equal(result.ok.length, 10)
        await mod[`handleUpdate${kind}`]()
        assert.equal(issues.length, 2)
    }
})

test('sold card retries errors without remounting, prevents duplicate requests and caches genuine empty results', async () => {
    const states = [], refs = []
    let cursor = 0, refCursor = 0, calls = 0, resolveRequest
    const mod = compile(read('src/pages/invest/SoldTracker.tsx'), {
        require: createRequire(import.meta.url),
        useState: initial => { const i = cursor++; if (!(i in states)) states[i] = initial; return [states[i], value => { states[i] = typeof value === 'function' ? value(states[i]) : value }] },
        useRef: initial => { const i = refCursor++; return refs[i] ??= { current: initial } },
        useCallback: fn => fn,
        toLocalDateString: () => '2026-09-18',
        getHistoricalCandles: () => { calls++; return new Promise(resolve => { resolveRequest = resolve }) },
        ...Object.fromEntries(['RefreshCw', 'TrendingDown', 'ChevronDown', 'ChevronRight', 'BarChart2', 'Bell', 'Settings2', 'X', 'AlertTriangle', 'Info'].map(key => [key, key])),
    }, 'export { SoldCard }')
    const render = () => { cursor = 0; refCursor = 0; return mod.SoldCard({ record: { code: '2330', date: '2026-09-01', shares: 100, soldPrice: 100, soldNet: 10000, currentPrice: null }, verdictThreshold: 5 }) }
    const toggle = tree => findNodes(tree, n => n.type === 'div' && n.props.onClick)[0].props.onClick()
    toggle(render())
    toggle(render())
    toggle(render())
    assert.equal(calls, 1)
    resolveRequest(null)
    await settle()
    const failed = render()
    assert.equal(findNodes(failed, n => n.props.role === 'alert').length, 1)
    const retry = findNodes(failed, n => n.type === 'button' && n.props.children === '重試')[0]
    retry.props.onClick()
    assert.equal(calls, 2)
    resolveRequest({ data: [] })
    await settle()
    assert.equal(findNodes(render(), n => n.props.role === 'alert').length, 0)
    toggle(render())
    toggle(render())
    assert.equal(calls, 2)
})

test('quote requests share a rolling minute budget across batches and deduplicate concurrent symbols', async () => {
    const h = quotesHarness(() => okQuote())
    const codes = Array.from({ length: 90 }, (_, i) => String(1000 + i))
    const [a, b] = await Promise.all([
        h.getMultipleQuoteObservations(codes, '2026-09-18T01:00:00Z'),
        h.getMultipleQuoteObservations([codes[0], codes[0]], '2026-09-18T01:00:01Z'),
    ])
    assert.equal(Object.keys(a).length, 90)
    assert.equal(b[codes[0]].price, 120)
    assert.equal(h.starts.filter(s => s.symbol === codes[0]).length, 1)
    for (const start of h.starts) assert.ok(h.starts.filter(s => s.time >= start.time && s.time < start.time + 61000).length <= 55)
    assert.equal(h.starts.length, 55)
    assert.equal(Object.values(a).filter(q => q.status === 'failed').length, 35)
    assert.ok(h.starts.at(-1).time - h.starts[0].time < 1000)
})

test('two identical 20-symbol batches claim quota once before a pending reservation returns', async () => {
    let releaseBudget, active = 0, maxActive = 0
    const budget = new Promise(resolve => { releaseBudget = resolve })
    const h = quotesHarness(async () => {
        active++; maxActive = Math.max(maxActive, active)
        await new Promise(resolve => setImmediate(resolve))
        active--; return okQuote()
    }, () => budget)
    const codes = Array.from({ length: 20 }, (_, i) => String(1000 + i))
    const first = h.getMultipleQuoteObservations(codes, '2026-09-18T01:00:00Z')
    const second = h.getMultipleQuoteObservations(codes, '2026-09-18T01:00:01Z')
    await settle(); assert.ok(h.budgetRequests.every(count => count === 1)); assert.equal(h.starts.length, 0)
    releaseBudget({ granted: 20, retryAfter: 0 })
    const [a, b] = await Promise.all([first, second])
    assert.equal(h.starts.length, 20); assert.equal(maxActive, 5)
    assert.equal(new Set(h.starts.map(row => row.symbol)).size, 20)
    assert.ok(Object.values(a).every(row => row.price === 120 && row.requestedAt === '2026-09-18T01:00:00Z'))
    assert.ok(Object.values(b).every(row => row.price === 120 && row.requestedAt === '2026-09-18T01:00:01Z'))
})

test('partially overlapping batches reserve the union rather than both full lists', async () => {
    const h = quotesHarness(() => okQuote())
    const codes = Array.from({ length: 30 }, (_, i) => String(1000 + i))
    const [a, b] = await Promise.all([
        h.getMultipleQuoteObservations(codes.slice(0, 20), '2026-09-18T01:00:00Z'),
        h.getMultipleQuoteObservations(codes.slice(10), '2026-09-18T01:00:01Z'),
    ])
    assert.ok(h.budgetRequests.every(count => count === 1)); assert.equal(h.starts.length, 30)
    assert.equal(new Set(h.starts.map(row => row.symbol)).size, 30)
    assert.equal(Object.keys(a).length, 20); assert.equal(Object.keys(b).length, 20)
    assert.ok([...Object.values(a), ...Object.values(b)].every(row => row.status === 'success'))
})

test('a late caller reuses completed work inside a pending batch without inventing a newer fetch timestamp', async () => {
    let releaseTail
    const tail = new Promise(resolve => { releaseTail = resolve })
    const h = quotesHarness(async url => { if (url.endsWith('/1001')) await tail; return okQuote() })
    const pending = h.getMultipleQuoteObservations(['1000', '1001'], '2026-09-18T01:00:00Z')
    await settle()
    assert.equal(h.starts.length, 2)
    const actualFetchedAt = new Date(h.starts[0].time).toISOString()
    h.advance(5000)
    const late = await h.getMultipleQuoteObservations(['1000'], '2026-09-18T01:00:05Z')
    assert.ok(h.budgetRequests.every(count => count === 1)); assert.equal(h.starts.length, 2)
    assert.equal(late['1000'].fetchedAt, actualFetchedAt)
    releaseTail()
    assert.equal((await pending)['1000'].fetchedAt, actualFetchedAt)
})

test('single-symbol reads share batch claims in either arrival order, including a queued tail symbol', async () => {
    const codes = Array.from({ length: 20 }, (_, i) => String(1000 + i))
    for (const batchFirst of [true, false]) {
        const h = quotesHarness(() => okQuote())
        let batch, single
        if (batchFirst) {
            batch = h.getMultipleQuoteObservations(codes, '2026-09-18T01:00:00Z')
            single = h.getQuote(codes.at(-1))
        } else {
            single = h.getQuote(codes.at(-1))
            batch = h.getMultipleQuoteObservations(codes, '2026-09-18T01:00:00Z')
        }
        const [rows, quote] = await Promise.all([batch, single])
        assert.equal(h.budgetRequests.length,20)
        assert.equal(h.starts.length, 20); assert.equal(rows[codes.at(-1)].price, 120); assert.equal(quote.closePrice, 120)
    }
})

test('partial proxy failures settle shared callers and release claims for a later retry', async () => {
    let repaired=false
    const h=quotesHarness(url=> !repaired && Number(url.split('/').at(-1))>=1003 ? {ok:false,status:403} : okQuote())
    const codes=Array.from({length:6},(_,i)=>String(1000+i))
    const [a,b]=await Promise.all([h.getMultipleQuoteObservations(codes,'2026-09-18T01:00:00Z'),h.getMultipleQuoteObservations(codes,'2026-09-18T01:00:01Z')])
    assert.equal(h.starts.length,6); assert.equal(Object.values(a).filter(row=>row.status==='success').length,3)
    assert.deepEqual(Object.values(a).map(row=>row.status),Object.values(b).map(row=>row.status))
    repaired=true
    assert.ok(Object.values(await h.getMultipleQuoteObservations(codes,'2026-09-18T01:00:02Z')).every(row=>row.status==='success'))
    assert.equal(h.starts.length,12)
})

test('a shared quote retry reserves one extra attempt without duplicating other callers', async () => {
    const h = quotesHarness((_, call) => call === 1 ? { ok: false, status: 503 } : okQuote())
    const [a, b] = await Promise.all([
        h.getMultipleQuoteObservations(['2330'], '2026-09-18T01:00:00Z'),
        h.getMultipleQuoteObservations(['2330'], '2026-09-18T01:00:01Z'),
    ])
    assert.ok(h.budgetRequests.every(count => count === 1)); assert.equal(h.starts.length, 2)
    assert.equal(a['2330'].price, 120); assert.equal(b['2330'].price, 120)
})

test('foreground 429 returns promptly and respects Retry-After before any later request', async () => {
    for (const retryAfter of ['60', null]) {
        const h = quotesHarness((_, call) => call === 1
            ? { ok: false, status: 429, headers: { get: () => retryAfter } } : okQuote())
        const result = await h.getMultipleQuoteObservations(['2330'], '2026-09-18T01:00:00Z')
        assert.equal(result['2330'].status, 'failed')
        assert.equal(h.starts.length, 1)
        await h.getMultipleQuoteObservations(['2330'], '2026-09-18T01:00:01Z')
        assert.equal(h.starts.length, 1)
        h.advance(retryAfter ? 60000 : 61000)
        assert.equal((await h.getMultipleQuoteObservations(['2330'], '2026-09-18T01:02:00Z'))['2330'].status, 'success')
        assert.ok(h.starts[1].time - h.starts[0].time >= (retryAfter ? 60000 : 61000))
    }
})

test('permanent quote failures do not retry and keep useful diagnostics; partial success survives', async () => {
    const h = quotesHarness(url => url.endsWith('2330') ? okQuote() : { ok: false, status: 403 })
    const result = await h.getMultipleQuoteObservations(['2330', '2317'], '2026-09-18T01:00:00Z')
    assert.equal(h.starts.length, 2)
    assert.equal(result['2330'].price, 120)
    assert.equal(result['2317'].price, null)
    assert.match(result['2317'].error, /權限/)
})

test('a refused or unavailable shared budget never sends a metered quote request', async () => {
    for (const budgeter of [() => ({ granted: 0, retryAfter: 70 }), () => { throw Error('offline') }]) {
        const h = quotesHarness(() => assert.fail('Metered request without grant'), budgeter)
        const result = await h.getMultipleQuoteObservations(['2330'], '2026-10-01T02:00:00Z')
        assert.equal(h.starts.length, 0); assert.equal(result['2330'].status, 'failed')
        assert.match(result['2330'].error, /額度|限流|HTTP/)
    }
})

test('quote retries stay inside the refresh deadline and also reserve shared quota', async () => {
    let leases = 0
    const h = quotesHarness(() => ({ ok: false, status: 503 }), count => { leases += count; return { granted: count, retryAfter: 0 } })
    const result = await h.getMultipleQuoteObservations(['2330'], '2026-10-01T02:00:00Z')
    assert.equal(result['2330'].status, 'failed'); assert.equal(h.starts.length, 2); assert.equal(leases, 2)
    const expired = quotesHarness(() => assert.fail('No HTTP after deadline'))
    assert.equal((await expired.getMultipleQuoteObservations(['2330'], '2026-10-01T02:00:00Z', 0))['2330'].status, 'failed')
})

// Simulate concurrent proxy latency and abort signals without real network waits.
function slowProxyHarness(latency) {
    let time = Date.parse('2026-10-06T06:00:00Z'), active = 0, peak = 0
    const initial = time, timers = [], calls = []
    const schedule = (callback, delay) => timers.push({ at: time + delay, callback })
    class Clock extends Date {
        constructor(...args) { super(...(args.length ? args : [time])) }
        static now() { return time }
    }
    const mod = compile(read('src/lib/fugle.ts'), {
        ...policy, ...quoteTiming, Date: Clock, setTimeout: schedule,
        AbortSignal: { timeout: delay => {
            const controller = new AbortController()
            schedule(() => controller.abort(), delay)
            return controller.signal
        } },
        captureUserSession: () => ({ assertActive() {} }),
        authenticatedFetch: (_path, _session, options) => new Promise((resolve, reject) => {
            const symbol = JSON.parse(options.body).symbol
            calls.push({ symbol, at: time }); peak = Math.max(peak, ++active)
            let finished = false
            const abort = () => { if (!finished) { finished = true; active--; reject(new Error('proxy interrupted')) } }
            options.signal.addEventListener('abort', abort, { once: true })
            schedule(() => {
                if (finished) return
                finished = true; active--; options.signal.removeEventListener('abort', abort)
                resolve(okQuote({ symbol, date: '2026-10-06' }))
            }, latency)
        }),
    })
    const finish = async promise => {
        let settled = false
        promise.then(() => { settled = true }, () => { settled = true })
        for (let i = 0; i < 1000; i++) {
            await settle()
            if (settled) return promise
            timers.sort((a, b) => a.at - b.at)
            const next = timers.shift()
            assert.ok(next, 'pending proxy must retain a timeout')
            time = next.at; next.callback()
        }
        assert.fail('proxy did not settle within its bounded timers')
    }
    return { ...mod, finish, calls, metrics: () => ({ elapsed: time - initial, peak }) }
}

test('ten six-second proxy quotes complete across worker waves instead of expiring at five/eight seconds', async () => {
    const h = slowProxyHarness(6000), codes = Array.from({length:10}, (_,i) => String(1000+i))
    const result = await h.finish(h.getMultipleQuoteObservations(codes, '2026-10-06T06:00:00Z'))
    assert.ok(Object.values(result).every(q => q.status === 'success' && q.price === 120))
    assert.equal(h.calls.length,10)
    assert.deepEqual(h.metrics(),{elapsed:12000,peak:5})
})

test('a hanging proxy remains batch-bounded without duplicating interrupted metered requests', async () => {
    const h = slowProxyHarness(25000), codes = Array.from({length:20}, (_,i) => String(1000+i))
    const result = await h.finish(h.getMultipleQuoteObservations(codes, '2026-10-06T06:00:00Z'))
    assert.ok(Object.values(result).every(q => q.status === 'failed' && q.price === null))
    assert.equal(h.metrics().elapsed,60000)
    assert.equal(h.calls.length,15)
    assert.equal(new Set(h.calls.map(c => c.symbol)).size,h.calls.length)
})

test('an explicit shorter refresh deadline still stops queued requests and retains completed quotes', async () => {
    const h = slowProxyHarness(6000), codes = Array.from({length:10}, (_,i) => String(1000+i))
    const result = await h.finish(h.getMultipleQuoteObservations(codes, '2026-10-06T06:00:00Z', Date.parse('2026-10-06T06:00:08Z')))
    assert.equal(Object.values(result).filter(q => q.status === 'success').length,5)
    assert.equal(h.metrics().elapsed,8000)
    assert.equal(h.calls.length,10)
})

test('lastTrade and current dated reference quotes retain their provenance and support daily trend snapshots', async () => {
    const h = quotesHarness(url => okQuote(url.endsWith('2330')
        ? { closePrice: undefined, lastTrade: { price: 125 }, referencePrice: 100 }
        : { closePrice: undefined, referencePrice: 100 }))
    const result = await h.getMultipleQuoteObservations(['2330', '2317'], '2026-09-18T01:00:00Z')
    assert.equal(result['2330'].price, 125)
    assert.equal(result['2330'].priceType, 'trade')
    assert.equal(result['2317'].priceType, 'reference')
    assert.deepEqual(policy.stalePriceCodes(['2317'], policy.mergeQuoteObservations({}, result)),[])
})

function findNodes(node, predicate) {
    if (!node || typeof node !== 'object') return []
    if (Array.isArray(node)) return node.flatMap(n => findNodes(n, predicate))
    return [...(predicate(node) ? [node] : []), ...findNodes(node.props?.children, predicate)]
}
const settle = () => new Promise(resolve => setImmediate(resolve))

function dashboardRefreshHarness() {
    let finishQuotes, finishMeetings, failMeetings
    const notices = [], holdingUpdates = [], busy = []
    const quotes = new Promise(resolve => { finishQuotes = resolve })
    const meetings = new Promise((resolve, reject) => { finishMeetings = resolve; failMeetings = reject })
    const source = read('src/pages/invest/Dashboard.tsx')
    const ast = ts.createSourceFile('dashboard.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
    let initializer
    const visit = node => {
        if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'updatePrices') initializer = node.initializer
        ts.forEachChild(node, visit)
    }
    visit(ast)
    const { run } = compile('export const run = ' + initializer.getText(ast), {
        syncingInvestorMeetings: false, priceLoading: false, priceRefreshGeneration: { current: 0 }, captureUserSession: () => ({ assertActive() {} }),
        setSyncingInvestorMeetings: value => busy.push(value),
        syncYahooInvestorMeetings: () => meetings,
        holdings: [{ code: '2330', shares: 10 }], sellTradesCache: [],
        ctxUpdatePrices: async (_, options) => {
            const result = await quotes
            options.onSnapshot({ status: 'stale-prices' })
            return result
        },
        formatAutoSnapshotFeedback: () => ({ type: 'info', message: '來源日期不符，快照未儲存。' }),
        calcHoldingValuation: (holding, price) => ({ currentPrice: price, marketValue: holding.shares * price }),
        setHoldings: value => holdingUpdates.push(value),
        showNotice: value => notices.push(value),
    })
    return { run, notices, holdingUpdates, busy, finishQuotes, finishMeetings, failMeetings }
}

test('dashboard publishes quote/snapshot feedback while slow meeting sync remains pending', async () => {
    const h = dashboardRefreshHarness()
    const pending = h.run()
    h.finishQuotes({ 2330: 120 })
    await settle()
    assert.equal(h.holdingUpdates[0][0].marketValue, 1200)
    assert.equal(h.notices.length, 1)
    assert.match(h.notices[0].message, /已更新 1 檔股票現價/)
    assert.match(h.notices[0].message, /快照未儲存/)
    assert.deepEqual(h.busy, [true])
    await pending // Foreground promise resolves before the meeting request.
    h.finishMeetings({ fetched: 8, changedGroups: 2 })
    await settle()
    assert.deepEqual(h.busy, [true, false])
    assert.match(h.notices.at(-1).message, /法說會已同步，更新 2 組/)
})

test('meeting failure before quotes complete is handled without losing the successful quote result', async () => {
    const h = dashboardRefreshHarness()
    const pending = h.run()
    h.failMeetings(Error('fixture unavailable'))
    await settle() // An unhandled rejection would fail this test.
    assert.equal(h.notices.length, 0)
    h.finishQuotes({ 2330: 120 })
    await pending
    await settle()
    assert.deepEqual(h.busy, [true, false])
    assert.match(h.notices.at(-1).message, /已更新 1 檔股票現價/)
    assert.match(h.notices.at(-1).message, /法說會暫時無法同步/)
})

function soldHarness() {
    const states = [], effects = [], price = { prices: { 2330: 120 }, priceErrors: {}, priceLoading: false, lastUpdated: 'now' }
    let cursor = 0, effectCursor = 0, version = 0
    const called = []
    price.updatePrices = async codes => { called.push(codes); return price.prices }
    const mod = compile(read('src/pages/invest/SoldTracker.tsx'), {
        buttonFill,
        require: createRequire(import.meta.url),
        useState: initial => { const i = cursor++; if (!(i in states)) states[i] = initial; return [states[i], value => { states[i] = typeof value === 'function' ? value(states[i]) : value }] },
        useCallback: fn => fn,
        useEffect: (fn, deps) => { const i = effectCursor++, old = effects[i]; if (!old || deps.some((v, j) => v !== old.deps[j])) { old?.cleanup?.(); effects[i] = { deps, cleanup: fn() } } },
        useInvestSync: () => ({ version }), usePrices: () => price,
        captureUserSession: () => ({ assertActive() {} }), investDB: {}, userDocNested: () => 'fixture',
        getDoc: async () => ({ exists: () => false }),
        fetchTrades: async () => [
            { id: 's', date: new Date().toISOString().slice(0, 10), type: 'sell', code: '2330', price: 100, shares: 100, total: 10000, name: 'fixture', note: '' },
            { id: 'old', date: '2000-01-01', type: 'sell', code: '2317', price: 50, shares: 100, total: 5000, name: 'old', note: '' },
        ],
        ...Object.fromEntries(['RefreshCw', 'TrendingDown', 'ChevronDown', 'ChevronRight', 'BarChart2', 'Bell', 'Settings2', 'X', 'AlertTriangle', 'Info'].map(key => [key, key])),
    })
    return { price, called, sync: () => version++, render: () => { cursor = 0; effectCursor = 0; return mod.default() } }
}

test('sold rows use shared quotes on mount, after settings sync, and when a quote fails', async () => {
    const h = soldHarness()
    const records = tree => findNodes(tree, n => n.type?.name === 'SoldCard').map(n => n.props.record)
    h.render(); await settle()
    assert.equal(records(h.render())[0].currentPrice, 120)
    h.price.prices = { 2330: 150 }; h.sync(); h.render(); await settle()
    const row = records(h.render())[0]
    assert.equal(row.currentPrice, 150)
    assert.equal((row.currentPrice - row.soldPrice) * row.shares, 5000)
    h.price.prices = { 2330: null }; h.sync(); h.render(); await settle()
    assert.equal(records(h.render())[0].currentPrice, null)
})

test('sold refresh includes historical sales regardless of the displayed tracking period', async () => {
    const h = soldHarness(); h.render(); await settle()
    const button = findNodes(h.render(), n => n.type === 'button' && n.props.children?.includes('更新現價'))[0]
    await button.props.onClick()
    assert.deepEqual(h.called, [['2330', '2317']])
})

test('API infrastructure errors keep authentication closed and expose only safe diagnostic codes', async () => {
    for (const code of ['auth/insufficient-permission', 'app/invalid-credential', 'auth/internal-error', 'unsafe token=secret']) {
        const logs = []
        const mod = compile(read('netlify/lib/api-access.js'), {
            process: { env: { API_FIREBASE_PROJECT_ID: 'fixture', API_ALLOWED_UIDS: 'a', API_FIREBASE_SERVICE_ACCOUNT: '{}' } },
            getApps: () => [{ name: 'protected-api' }],
            getAuth: () => ({ verifyIdToken: async (_, revoked) => { assert.equal(revoked, true); throw { code, message: 'private token=secret' } } }),
            console: { error: (...args) => logs.push(args) },
        })
        const result = await mod.authorizeApi({ httpMethod: 'GET', headers: { authorization: 'Bearer token' } }, 'news')
        assert.equal(result.statusCode, 503)
        assert.ok(!JSON.stringify([result, logs]).includes('secret'))
        assert.match(result.body, new RegExp(code.startsWith('unsafe') ? 'unknown' : code))
    }
})

const credentialCases = [
    ['runtime-module-missing', { message: "Cannot find module './fixture-module.js'" }],
    ['runtime-module-incompatible', { message: 'Dynamic require of "node:crypto" is not supported' }],
    ['runtime-module-incompatible', { code: 'ERR_REQUIRE_ESM' }],
    ['runtime-type-error', { name: 'TypeError', message: 'fetch is not a function' }],
    ['runtime-type-error', { message: "Cannot read properties of undefined (reading 'fixture')" }],
    ['credential-key-format', { message: 'error:1E08010C:DECODER routines::unsupported' }],
    ['credential-key-format', { code: 'ERR_OSSL_UNSUPPORTED' }],
    ['credential-key-missing', { message: 'No key or keyFile set.' }],
    ['oauth-token-response-invalid', { message: 'Failed to parse Google auth credential: Invalid expiry_date.' }],
    ['oauth-token-response-invalid', { message: 'Invalid access token generated: sensitive' }],
    ['network-tls', { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' }],
    ['network-tls', { code: 'CERT_HAS_EXPIRED' }],
    ['network-connection', { message: 'fetch failed' }],
    ['jwt-signature-invalid', { response: { status: 400, data: { error: 'invalid_grant', error_description: 'Invalid JWT Signature.' } } }],
    ['jwt-time-invalid', { response: { data: { error: 'invalid_grant', error_description: 'Invalid JWT: Token must be a short-lived token (60 minutes) and in a reasonable timeframe.' } } }],
    ['service-account-disabled', { message: 'Service account has been disabled' }],
    ['oauth-client-disabled', { response: { data: { error: 'disabled_client' } } }],
    ['oauth-client-deleted', { response: { data: { error: 'deleted_client' } } }],
    ['oauth-client-invalid', { response: { data: { error: 'invalid_client' } } }],
    ['oauth-client-unauthorized', { response: { data: { error: 'unauthorized_client' } } }],
    ['oauth-scope-invalid', { response: { data: { error: 'invalid_scope' } } }],
    ['oauth-grant-rejected', { message: 'invalid_grant: unspecified rejection' }],
    ['oauth-grant-rejected', { message: 'Token has been expired or revoked' }],
    ['network-dns', { code: 'ENOTFOUND' }],
    ['network-dns', { cause: { code: 'EAI_AGAIN' } }],
    ['network-timeout', { code: 'ETIMEDOUT' }],
    ['network-timeout', { cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } }],
    ['network-connection', { code: 'ECONNRESET' }],
    ['upstream-unavailable', { response: { status: 503, data: {} } }],
    ['jwt-signature-invalid', { httpResponse: { status: 400, data: { error: 'invalid_grant', error_description: 'Invalid JWT Signature.' } } }],
    ['unclassified', { message: 'Unrecognized provider error' }],
]

for (const [reason, cause] of credentialCases) {
    test(`authentication diagnosis safely reports ${reason} without reaching quota or news fetch`, async () => {
        const secret = 'DO_NOT_EXPOSE_PRIVATE_KEY_OR_ACCESS_TOKEN'
        const logs = []
        const error = Object.assign(new Error(`credential failed: ${secret}`, { cause }), { code: 'app/invalid-credential' })
        cause.config = { headers: { Authorization: `Bearer ${secret}` }, data: `private_key=${secret}` }
        error.private_key = secret
        error.toJSON = () => { throw new Error('Must not serialize SDK errors') }
        const mod = compile(read('netlify/lib/api-access.js'), {
            process: { env: { API_FIREBASE_PROJECT_ID: 'fixture', API_ALLOWED_UIDS: 'a', API_FIREBASE_SERVICE_ACCOUNT: '{}' } },
            getApps: () => [{ name: 'protected-api' }],
            getAuth: () => ({ verifyIdToken: async (token, revoked) => { assert.equal(token, secret); assert.equal(revoked, true); throw error } }),
            getFirestore: () => assert.fail('Verification failure must not reach quota'),
            fetch: () => assert.fail('Verification failure must not fetch news'),
            console: { error: (...args) => logs.push(args) },
        })
        const result = await mod.authorizeApi({ httpMethod: 'GET', headers: { authorization: `Bearer ${secret}` } }, 'news')
        assert.equal(result.statusCode, 503)
        assert.equal(JSON.parse(result.body).error, `驗證服務憑證無法使用，請聯絡管理者（app/invalid-credential；${reason}）`)
        const shape = mod.authenticationErrorShape(error)
        assert.deepEqual(logs, [['[protected-api] authentication unavailable', { route: 'news', code: 'app/invalid-credential', reason, ...shape }]])
        assert.ok(!JSON.stringify([result, logs]).includes(secret))
    })
}

test('diagnostics do not mistake SDK boilerplate for a proven clock or revoked-key error', () => {
    const { authenticationDiagnostic } = compile(read('netlify/lib/api-access.js'))
    const message = 'invalid_grant. There are two likely causes: (1) your server time is not properly synced or (2) your certificate key file has been revoked.'
    assert.equal(authenticationDiagnostic({ code: 'app/invalid-credential', message }).reason, 'oauth-grant-rejected')
    assert.equal(authenticationDiagnostic({ code: 'app/invalid-credential', message, cause: { code: 'ETIMEDOUT' } }).reason, 'network-timeout')
    const cyclic = { code: 'app/private-sensitive-code', message: 'private-sensitive-message' }
    cyclic.cause = cyclic
    assert.deepEqual(authenticationDiagnostic(cyclic), { code: 'unknown', reason: 'unclassified' })
    for (const error of [null, undefined, 123, 'private-sensitive-error', { code: 'app/invalid-credential', message: 'x'.repeat(100000) }]) {
        assert.equal(authenticationDiagnostic(error).reason, 'unclassified')
    }
    assert.deepEqual(authenticationDiagnostic({ code: 'auth/insufficient-permission' }), { code: 'auth/insufficient-permission', reason: 'permission-denied' })
})

test('authentication shape logs only allowed classes, bounds cycles and omits arbitrary strings', () => {
    const { authenticationErrorShape } = compile(read('netlify/lib/api-access.js'))
    const error = { name: 'FirebaseAppError', message: 'secret', cause: { name: 'TypeError', message: 'secret' } }
    assert.deepEqual(authenticationErrorShape(error), { errorTypes: ['FirebaseAppError', 'TypeError'], hasNestedCause: true })
    error.cause.cause = error
    assert.deepEqual(authenticationErrorShape(error), { errorTypes: ['FirebaseAppError', 'TypeError'], hasNestedCause: true })
    assert.deepEqual(authenticationErrorShape({ name: 'secret-custom-class', stack: 'secret-stack' }), { errorTypes: ['unknown'], hasNestedCause: false })
    assert.deepEqual(authenticationErrorShape(null), { errorTypes: [], hasNestedCause: false })
    let deep = { name: 'Error' }
    for (let i = 0; i < 10; i++) deep = { name: 'Error', cause: deep }
    assert.equal(authenticationErrorShape(deep).errorTypes.length, 5)
})

test('invalid user credentials still return 401 with no infrastructure diagnostic', async () => {
    for (const code of ['auth/id-token-expired', 'auth/id-token-revoked', 'auth/invalid-id-token', 'auth/argument-error', 'auth/user-disabled', 'auth/user-not-found']) {
        const mod = compile(read('netlify/lib/api-access.js'), {
            process: { env: { API_FIREBASE_PROJECT_ID: 'fixture', API_ALLOWED_UIDS: 'a', API_FIREBASE_SERVICE_ACCOUNT: '{}' } },
            getApps: () => [{ name: 'protected-api' }],
            getAuth: () => ({ verifyIdToken: async () => { throw { code, message: 'sensitive' } } }),
            getFirestore: () => assert.fail('No quota access on invalid credentials'),
            console: { error: () => assert.fail('No infrastructure log for invalid credentials') },
        })
        const result = await mod.authorizeApi({ httpMethod: 'GET', headers: { authorization: 'Bearer fixture' } }, 'news')
        assert.equal(result.statusCode, 401)
        assert.deepEqual(JSON.parse(result.body), { error: '登入憑證失效，請重新登入' })
    }
})

test('Firebase public-key network failures are service errors, not expired user credentials, and never bypass verification', async () => {
    for (const cause of ['Error while making request: . Error code: EACCES', 'request timed out', 'fetch failed']) {
        const logs=[]
        const mod=compile(read('netlify/lib/api-access.js'),{
            process:{env:{API_FIREBASE_PROJECT_ID:'fixture',API_ALLOWED_UIDS:'a',API_FIREBASE_SERVICE_ACCOUNT:'{}'}},
            getApps:()=>[{name:'protected-api'}],
            getAuth:()=>({verifyIdToken:async(_,revoked)=>{assert.equal(revoked,true);throw {code:'auth/argument-error',message:`error in secret or public key callback: ${cause}; private fixture-secret`}}}),
            getFirestore:()=>assert.fail('no data or quota access without verified identity'),
            console:{error:(...args)=>logs.push(args)},
        })
        const result=await mod.authorizeApiIdentity({httpMethod:'POST',headers:{authorization:'Bearer fixture'}},'ai',1,'POST')
        assert.equal(result.statusCode,503);assert.match(result.body,/登入驗證服務連線失敗/)
        assert.doesNotMatch(result.body,/憑證失效|重新登入/)
        assert.doesNotMatch(JSON.stringify([result,logs]),/fixture-secret/)
        assert.equal(logs.length,1)
        if(cause.includes('EACCES'))assert.match(result.body,/network-access-denied/)
    }
})

test('frontend forwards safe diagnostic labels into the existing error display', async () => {
    const message = '驗證服務憑證無法使用，請聯絡管理者（app/invalid-credential；jwt-signature-invalid）'
    const { authenticatedFetch } = compile(read('src/lib/authenticatedFetch.ts'), {
        captureUserSession: () => ({ assertActive() {} }),
        investAuth: { currentUser: { getIdToken: async () => 'fixture' } },
        fetch: async () => ({ ok: false, status: 503, headers: { get: () => null }, json: async () => ({ error: message }) }),
    })
    await assert.rejects(authenticatedFetch('/.netlify/functions/news-proxy'), error => error.message === message)
})

test('frontend explains an HTML SPA fallback instead of exposing a JSON parser error', async () => {
    for (const contentType of ['text/html; charset=utf-8', 'application/xhtml+xml']) {
        let calls = 0
        const { authenticatedFetch } = compile(read('src/lib/authenticatedFetch.ts'), {
            captureUserSession: () => ({ assertActive() {} }),
            investAuth: { currentUser: { getIdToken: async () => 'fixture' } },
            fetch: async () => {
                calls++
                return { ok: true, status: 200, headers: { get: () => contentType },
                    json: () => assert.fail('HTML must not be parsed as JSON') }
            },
        })
        await assert.rejects(authenticatedFetch('/.netlify/functions/news-proxy'), /已啟動 Netlify 後端/)
        assert.equal(calls, 1)
    }
})

test('news and Yahoo calendar return the classified 503 before cache lookup or provider fetch', async () => {
    const access = compile(read('netlify/lib/api-access.js'), {
        process: { env: { API_FIREBASE_PROJECT_ID: 'fixture', API_ALLOWED_UIDS: 'a', API_FIREBASE_SERVICE_ACCOUNT: '{}' } },
        getApps: () => [{ name: 'protected-api' }, { name: 'protected-meetings-api' }],
        getAuth: () => ({ verifyIdToken: async () => { throw { code: 'app/invalid-credential', cause: { code: 'ECONNRESET' } } } }),
        console: { error() {} },
        getFirestore: () => assert.fail('No quota access'),
    })
    for (const file of ['news-proxy', 'yahoo-calendar-proxy']) {
    const endpoint = compile(read(`netlify/functions/${file}.js`), {
        authorizeApi: access.authorizeApi,
        apiHeaders: access.apiHeaders,
        cachedApi: () => assert.fail('No cache lookup on failed verification'),
        fetch: () => assert.fail('No news provider call on failed verification'),
    })
    const response = await endpoint.handleEvent({ httpMethod: 'GET', headers: { authorization: 'Bearer fixture' } })
    assert.equal(response.statusCode, 503)
    assert.match(JSON.parse(response.body).error, /app\/invalid-credential；network-connection/)
    }
})

test('a successful news fetch remains visible when session storage is unavailable', async () => {
    const source = read('src/pages/calendar/DailyBrief.tsx')
    const ast = ts.createSourceFile('test.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
    let callback
    const visit = node => { if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'loadNews') callback = node.initializer.arguments[0]; ts.forEachChild(node, visit) }
    visit(ast)
    const state = {}, news = [{ title: 'fixture', category: '市場', url: 'https://example.com', source: 'fixture' }]
    const run = compile('export const run = ' + callback.getText(ast), {
        newsRequest: { current: 0 }, getDailyNews: async () => news,
        toLocalDateString: () => '2026-09-18',
        sessionStorage: { setItem() { throw Error('storage disabled') } },
        ...Object.fromEntries(['News', 'NewsError', 'LastNewsTime', 'SelectedSources', 'NewsLoading'].map(key => ['set' + key, value => { state[key] = value }])),
    }).run
    await run()
    assert.deepEqual(state.News, news)
    assert.equal(state.NewsError, '')
    assert.equal(state.NewsLoading, false)
})
