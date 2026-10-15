import test from 'node:test'
import assert from 'node:assert/strict'
import { checkQuoteDeployment, validateQuoteDeploymentSettings } from '../scripts/check-quote-deployment.mjs'
import { compile, read } from './helpers/compile.mjs'
import { REQUIRED_FUNCTION_SETTINGS, productionFunctionOverrides, functionOverrideArguments, safeFunctionSettingsSummary } from '../scripts/production-function-settings.mjs'

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

test('release arguments always carry Fugle plus all existing settings, exclusively in Functions', () => {
    const env = Object.fromEntries(REQUIRED_FUNCTION_SETTINGS.map(key => [key, `secret-fixture-${key}`]))
    env.VITE_FUGLE_API_KEY = 'must-not-be-carried'
    const overrides = productionFunctionOverrides(env), args = functionOverrideArguments(overrides)
    assert.equal(overrides.length, 20)
    assert.ok(overrides.every(row => row.scopes.length === 1 && row.scopes[0] === 'functions'))
    assert.ok(args.includes('FUGLE_API_KEY=secret-fixture-FUGLE_API_KEY'))
    assert.equal(args[args.indexOf('FUGLE_API_KEY=secret-fixture-FUGLE_API_KEY') - 1], '--secret-env')
    assert.equal(overrides.filter(row => row.is_secret).length, 3)
    assert.ok(!args.some(value => value.includes('VITE_') || value.includes('must-not-be-carried')))
    assert.ok(!JSON.stringify(safeFunctionSettingsSummary(overrides)).includes('secret-fixture'))
})

test('release preparation refuses any missing setting, modified scope or lost Fugle argument', () => {
    const env = Object.fromEntries(REQUIRED_FUNCTION_SETTINGS.map(key => [key, 'private-fixture']))
    for (const key of REQUIRED_FUNCTION_SETTINGS) {
        const missing = { ...env, [key]: '' }
        assert.throws(() => productionFunctionOverrides(missing), error => error.message.includes(key) && !error.message.includes('private-fixture'))
    }
    const overrides = productionFunctionOverrides(env)
    assert.throws(() => functionOverrideArguments(overrides.filter(row => row.key !== 'FUGLE_API_KEY')), /不完整/)
    assert.throws(() => functionOverrideArguments(overrides.map(row => row.key === 'FUGLE_API_KEY' ? { ...row, scopes: ['builds', 'functions'] } : row)), /範圍/)
    assert.throws(() => functionOverrideArguments(overrides.map(row => row.key === 'FUGLE_API_KEY' ? { ...row, is_secret: false } : row)), /範圍/)
})
