import test from 'node:test'
import assert from 'node:assert/strict'
import { checkQuoteDeployment, validateQuoteDeploymentSettings } from '../scripts/check-quote-deployment.mjs'
import { compile, read } from './helpers/compile.mjs'

const complete = { FUGLE_API_KEY: 'private-key-fixture', API_FIREBASE_PROJECT_ID: 'fixture-project',
    API_FIREBASE_SERVICE_ACCOUNT: 'opaque-secret-marker', API_ALLOWED_UIDS: 'private-user-fixture' }

test('production quote preflight detects the missing deployment-only Fugle key without returning secrets', async () => {
    const { FUGLE_API_KEY: _key, ...missingKey } = complete
    const result = await checkQuoteDeployment(async () => missingKey)
    assert.deepEqual(result, { ready: false, context: 'production', scope: 'functions', missing: ['FUGLE_API_KEY'] })
    assert.ok(!JSON.stringify(result).includes('private-'))
    assert.deepEqual(validateQuoteDeploymentSettings(complete), {
        ready: true, context: 'production', scope: 'functions', missing: [],
    })
})

test('preflight rejects absent and whitespace settings; opaque server-side secrets remain valid', () => {
    for (const key of Object.keys(complete)) {
        assert.deepEqual(validateQuoteDeploymentSettings({ ...complete, [key]: '  ' }).missing, [key])
        assert.deepEqual(validateQuoteDeploymentSettings({ ...complete, [key]: null }).missing, [key])
    }
    assert.equal(validateQuoteDeploymentSettings(null).ready, false)
})

test('both actual proxy routes reject missing Fugle configuration before quota or provider access', async () => {
    const { handleEvent } = compile(read('netlify/functions/fugle-proxy.js'), {
        process: { env: {} }, authorizeApiIdentity: async () => ({ uid: 'fixture', db: {} }),
        apiError: (statusCode, error) => ({ statusCode, body: JSON.stringify({ error }) }),
        reserveQuoteBudget: () => assert.fail('Missing configuration must not reserve quota'),
        fetch: () => assert.fail('Missing configuration must not call Fugle'),
    })
    for (const kind of ['quote', 'history']) {
        const result = await handleEvent({ httpMethod: 'POST', body: JSON.stringify({ kind, symbol: 'IX0001', from: '2026-10-01', to: '2026-10-15' }) })
        assert.equal(result.statusCode, 503)
        assert.equal(JSON.parse(result.body).error, '伺服器尚未設定 Fugle 報價金鑰')
    }
})

test('proxy budget failure emits fixed diagnostics and stops before any provider request', async () => {
    const logs = []
    const { handleEvent } = compile(read('netlify/functions/fugle-proxy.js'), {
        process: { env: { FUGLE_API_KEY: 'private-key-fixture' } },
        authorizeApiIdentity: async () => ({ uid: 'fixture', db: {} }),
        apiError: (statusCode, error) => ({ statusCode, body: JSON.stringify({ error }) }),
        reserveQuoteBudget: async () => { throw { code: 14, message: 'secret-document-path' } },
        quotaDiagnostic: compile(read('netlify/lib/api-access.js')).quotaDiagnostic,
        console: { error: (...args) => logs.push(args) },
        fetch: () => assert.fail('Failed reservation must not call Fugle'),
    })
    const result = await handleEvent({ httpMethod: 'POST', body: JSON.stringify({ kind: 'quote', symbol: '2330' }) })
    assert.equal(result.statusCode, 503)
    assert.deepEqual(logs, [['[fugle-proxy] quote budget unavailable', { code: 'firestore/14', reason: 'database-unavailable' }]])
    assert.ok(!JSON.stringify([result, logs]).includes('secret'))
})
