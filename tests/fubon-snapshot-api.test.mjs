import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rmdir, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import fubonSnapshot, { handleFubonSnapshot } from '../netlify/functions/fubon-snapshot.js'
import { decodeFubonCertificate, resolveFubonCertificatePath } from '../netlify/lib/fubon-certificate.js'
import { createFubonClient } from '../netlify/lib/fubon-sdk.js'
import { fubonDiagnostic, fubonStage } from '../netlify/lib/fubon-diagnostic.js'

const event = body => ({ httpMethod: 'POST', body: JSON.stringify(body), headers: { authorization: 'Bearer fixture' } })

test('cloud failure diagnostics retain stage without exposing provider secrets', async () => {
    let error
    try { await fubonStage('sdk-load', () => { throw Error('secret-user /private/cert GLIBC_2.38 not found secret-key') }) }
    catch (failure) { error = failure }
    assert.deepEqual(fubonDiagnostic(error), { stage: 'sdk-load', reason: 'native-library' })
    assert.ok(!JSON.stringify(error).includes('secret'))
    assert.equal(error.cause, undefined)
    assert.deepEqual(fubonDiagnostic({ fubonStage: 'secret-key', fubonReason: 'secret-password' }), { stage: 'snapshot', reason: 'unknown' })
    const response = await handleFubonSnapshot(event({ codes: ['2330'] }), {
        authorizeApi: async () => null,
        cachedApi: async (_key, _ttl, loader) => loader(),
        readFubonMarket: async () => { throw error },
    })
    assert.equal(response.statusCode, 502)
    assert.deepEqual(JSON.parse(response.body).diagnostics, ['TSE', 'OTC'].map(market => ({ market, stage: 'sdk-load', reason: 'native-library' })))
    assert.ok(!response.body.includes('secret'))
})

test('SDK login and realtime failures are distinguished and sanitized', async () => {
    const settings = { id: 'fixture', key: 'fixture', certificatePath: 'fixture', certificatePassword: 'fixture' }
    class Rejected { apikeyLogin() { return { isSuccess: false, message: 'secret' } } }
    await assert.rejects(createFubonClient(Rejected, settings), error => {
        assert.deepEqual(fubonDiagnostic(error), { stage: 'login', reason: 'rejected' }); return true
    })
    class RealtimeFailed {
        apikeyLogin() { return { isSuccess: true } }
        initRealtime() { throw Error('secret-key ECONNRESET') }
    }
    await assert.rejects(createFubonClient(RealtimeFailed, settings), error => {
        assert.deepEqual(fubonDiagnostic(error), { stage: 'realtime', reason: 'connection' }); return true
    })
})

test('a 7,060-character certificate round-trips through two Netlify-sized values', () => {
    const contents = Buffer.alloc(5294, 0xa7)
    const encoded = contents.toString('base64')
    const parts = [encoded.slice(0, 4000), encoded.slice(4000)]
    assert.deepEqual(parts.map(part => part.length), [4000, 3060])
    assert.deepEqual(decodeFubonCertificate(undefined, parts), contents)
    assert.deepEqual(decodeFubonCertificate('obsolete single value', parts), contents)
    assert.deepEqual(decodeFubonCertificate(encoded), contents)
    assert.equal(decodeFubonCertificate(undefined, [undefined, undefined]), null)
})

test('incomplete, oversized and malformed certificate parts fail without returning partial data', () => {
    for (const parts of [['YWJj', undefined], [undefined, 'ZA=='], ['YWJj', ''],
        ['YWJj', '  '], ['A'.repeat(5001), 'ZA=='], ['YWJj', '!']]) {
        assert.throws(() => decodeFubonCertificate('YWJjZA==', parts), /fubon-cert-(parts-)?invalid/)
    }
})

test('hosted certificate is materialized privately and malformed input is rejected', async () => {
    await assert.rejects(resolveFubonCertificatePath({ certificateBase64: 'not base64!' }), /fubon-cert-invalid/)
    const temporaryDirectory = await mkdtemp(join(tmpdir(), 'fubon-cert-test-'))
    let certificatePath
    try {
        const encoded = Buffer.from('fixture certificate').toString('base64')
        certificatePath = await resolveFubonCertificatePath({
            certificateParts: [encoded.slice(0, 12), encoded.slice(12)], temporaryDirectory,
        })
        assert.ok(certificatePath.startsWith(temporaryDirectory))
        assert.equal(await readFile(certificatePath, 'utf8'), 'fixture certificate')
    } finally {
        if (certificatePath) await unlink(certificatePath)
        await rmdir(temporaryDirectory)
    }
})

test('modern hosted function rejects unauthenticated requests before loading the SDK', async () => {
    const response = await fubonSnapshot(new Request('http://localhost/.netlify/functions/fubon-snapshot', {
        method: 'POST', body: JSON.stringify({ codes: ['2330'] }),
    }))
    assert.equal(response.status, 401)
    assert.equal(response.headers.get('Cache-Control'), 'private, no-store')
})

test('read-only SDK adapter logs in once and only uses the snapshot API', async () => {
    const calls = []
    class SDK {
        marketdata = { restClient: { stock: { snapshot: { quotes: async options => {
            calls.push(['snapshot', options]); return { date: '2026-09-23', data: [] }
        } } } } }
        apikeyLogin(...args) { calls.push(['login', args]); return { isSuccess: true } }
        initRealtime() { calls.push(['initialize']); return true }
        stock = { placeOrder() { throw Error('order path must never be called') } }
    }
    const client = await createFubonClient(SDK, {
        id: 'fixture-id', key: 'fixture-key', certificatePath: 'fixture-cert', certificatePassword: 'fixture-password',
    })
    await client.quotes({ market: 'TSE', type: 'ALLBUT0999' })
    assert.deepEqual(calls.map(([name]) => name), ['login', 'initialize', 'snapshot'])
    assert.deepEqual(calls[2][1], { market: 'TSE', type: 'ALLBUT0999' })
})

test('protected snapshot endpoint rejects anonymous users before touching the SDK', async () => {
    let reads = 0
    const response = await handleFubonSnapshot(event({ codes: ['2330'] }), {
        authorizeApi: async () => ({ statusCode: 401, body: '{}' }),
        readFubonMarket: async () => { reads++ }, cachedApi: async () => { reads++ },
    })
    assert.equal(response.statusCode, 401)
    assert.equal(reads, 0)
})

test('snapshot endpoint accepts the historical universe limit and rejects larger requests before SDK access', async () => {
    let reads = 0
    const dependencies = {
        authorizeApi: async () => null,
        cachedApi: async (_key, _ttl, loader) => loader(),
        readFubonMarket: async () => { reads++; return { date: '2026-09-24', data: [] } },
    }
    const codes = Array.from({ length: 3000 }, (_, i) => `X${String(i).padStart(4, '0')}`)
    assert.equal((await handleFubonSnapshot(event({ codes }), dependencies)).statusCode, 200)
    assert.equal(reads, 2)
    assert.equal((await handleFubonSnapshot(event({ codes: [...codes, 'X3000'] }), dependencies)).statusCode, 400)
    assert.equal(reads, 2)
})

test('snapshot endpoint returns only requested symbols and retains a successful market', async () => {
    const response = await handleFubonSnapshot(event({ codes: ['2330', '0050'] }), {
        authorizeApi: async (_event, route, units, method) => {
            assert.deepEqual([route, units, method], ['fubonSnapshot', 1, 'POST']); return null
        },
        cachedApi: async (_key, _ttl, loader) => loader(),
        readFubonMarket: async market => {
            if (market === 'OTC') throw Error('secret upstream detail')
            return { date: '2026-09-23', data: [
                { symbol: '2330', lastPrice: 120, isTrial: false },
                { symbol: '9999', lastPrice: 50, isTrial: false },
            ] }
        },
    })
    assert.equal(response.statusCode, 200)
    const payload = JSON.parse(response.body)
    assert.deepEqual(payload.failedMarkets, ['OTC'])
    assert.deepEqual(payload.snapshots[0].data.map(row => row.symbol), ['2330'])
    assert.ok(!response.body.includes('secret upstream detail'))
})
