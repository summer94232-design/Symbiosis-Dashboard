// Prepare the new AI Functions variables locally. This script never calls Netlify or deploys.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { parseEnv } from 'node:util'
import { createHash } from 'node:crypto'
import { aiConfig } from '../netlify/lib/ai-policy.js'
import { validateApiConfig } from './check-api-config.mjs'

const env = parseEnv(readFileSync('.env', 'utf8'))
const config = aiConfig(env)
const fields = ['GEMINI_API_KEY', 'AI_ENABLED', 'AI_ALLOWED_PROVIDERS', 'AI_GEMINI_PAID',
    'AI_GEMINI_ACCOUNT', 'AI_GEMINI_PROJECT', 'AI_GEMINI_KEY_SHA256',
    'AI_KMS_PROJECT_ID', 'AI_KMS_SERVICE_ACCOUNT', 'AI_MONTHLY_TWD', 'AI_DAILY_TWD', 'AI_TURN_TWD', 'AI_RESEARCH_TWD', 'AI_USD_TWD',
    'AI_INVEST_DAILY_READS', 'AI_INVEST_DAILY_WRITES', 'AI_KMS_DAILY_READS', 'AI_KMS_DAILY_WRITES',
    'AI_DB_QUOTAS_CONFIRMED']
const errors = validateApiConfig(env)
for (const key of fields) if (!env[key]) errors.push(`缺少 ${key}`)
if (!config.enabled || !config.quotaConfirmed) errors.push('本機 AI 或已確認額度尚未啟用')
if (env.AI_ALLOWED_PROVIDERS !== 'gemini' || env.AI_GEMINI_PAID !== 'true') errors.push('Gemini 帳號範圍或付費設定不符')
if (env.AI_GEMINI_ACCOUNT !== 'summer94232@gmail.com' || env.AI_GEMINI_PROJECT !== 'gen-lang-client-0155504975') errors.push('Google 帳號或專案不符')
if (createHash('sha256').update(env.GEMINI_API_KEY || '').digest('hex') !== env.AI_GEMINI_KEY_SHA256) errors.push('Google 金鑰指紋不符')
try {
    const account = JSON.parse(env.AI_KMS_SERVICE_ACCOUNT || '')
    if (account.project_id !== env.AI_KMS_PROJECT_ID || !account.client_email || !account.private_key?.includes('BEGIN PRIVATE KEY')) errors.push('知識庫服務帳號不符')
} catch { errors.push('知識庫服務帳號 JSON 格式不符') }
if (fields.some(key => /[\r\n']/.test(env[key] || ''))) errors.push('環境變數包含無法安全匯出的字元')
if (errors.length) {
    console.error(JSON.stringify({ ready: false, errors }, null, 2))
    process.exitCode = 1
} else {
    mkdirSync('local-secrets', { recursive: true })
    const path = 'local-secrets/ai-netlify-functions.env'
    writeFileSync(path, `${fields.map(key => `${key}='${env[key]}'`).join('\n')}\n`, { mode: 0o600 })
    const roundTrip = parseEnv(readFileSync(path, 'utf8'))
    if (fields.some(key => roundTrip[key] !== env[key])) throw new Error('本機設定匯出比對失敗')
    console.log(JSON.stringify({ ready: true, path, variableCount: fields.length,
        target: 'production / Functions', existingApiAuthVariablesIncluded: false,
        productionModified: false, deploymentApprovalRequired: true }, null, 2))
}
