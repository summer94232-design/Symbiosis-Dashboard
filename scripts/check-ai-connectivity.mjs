// Deployment preflight. Never prints keys, credentials, UID values, or user notes.
// --generate sends synthetic text only and can incur a small token charge.
import { createHash } from 'node:crypto'
import { aiConfig } from '../netlify/lib/ai-policy.js'
import { providerRequest, parseProvider } from '../netlify/lib/ai-providers.js'
import { validateApiConfig } from './check-api-config.mjs'

const env = process.env, config = aiConfig(env)
const keyMatches = !!env.GEMINI_API_KEY && !!env.AI_GEMINI_KEY_SHA256
    && createHash('sha256').update(env.GEMINI_API_KEY).digest('hex') === env.AI_GEMINI_KEY_SHA256
const errors = validateApiConfig(env)
if (!config.enabled) errors.push('AI_ENABLED 尚未啟用')
if (!keyMatches) errors.push('GEMINI_API_KEY 缺少已核對的金鑰指紋或比對失敗')
if (env.AI_GEMINI_PAID !== 'true') errors.push('AI_GEMINI_PAID 尚未確認')
if (!env.AI_GEMINI_ACCOUNT || !env.AI_GEMINI_PROJECT) errors.push('Google 帳號與專案標示尚未完成')
if (env.AI_ALLOWED_PROVIDERS !== 'gemini') errors.push('本次帳號範圍要求 AI_ALLOWED_PROVIDERS=gemini')
if (!env.AI_KMS_PROJECT_ID) errors.push('缺少 AI_KMS_PROJECT_ID')
try {
    const account = JSON.parse(env.AI_KMS_SERVICE_ACCOUNT || '')
    if (account.project_id !== env.AI_KMS_PROJECT_ID) errors.push('知識庫服務帳號與 AI_KMS_PROJECT_ID 不一致')
    if (!account.client_email || !account.private_key?.includes('BEGIN PRIVATE KEY')) errors.push('知識庫服務帳號缺少必要欄位')
} catch { errors.push('AI_KMS_SERVICE_ACCOUNT 必須是有效的服務帳號 JSON') }
if (!config.quotaConfirmed) errors.push('AI_DB_QUOTAS_CONFIRMED 尚未確認實際資料庫額度')
console.log(JSON.stringify({ stage: 'configuration', ready: !errors.length, errors,
    googleAccount: env.AI_GEMINI_ACCOUNT || '未核對', googleProject: env.AI_GEMINI_PROJECT || '未核對', keyMatches,
    note: '格式檢查不代表遠端 Firebase 權限、生成或正式部署已驗證' }, null, 2))
if (errors.length) process.exitCode = 1

if (process.argv.includes('--generate')) {
    if (!keyMatches || env.AI_ALLOWED_PROVIDERS !== 'gemini' || env.AI_GEMINI_PAID !== 'true' || !config.enabled) {
        console.log(JSON.stringify({ stage: 'generation', skipped: 'Google 金鑰、帳號範圍或付費設定未通過檢查' }))
        process.exitCode = 1
    } else {
        for (const model of ['gemini-3.8-flash', 'gemini-3.5-flash-lite']) {
            const request = providerRequest(model, 'This is a connection test. Reply only OK.', [{ role: 'user', content: 'Reply only OK.' }], false, env)
            request.body.generation_config.max_output_tokens = 256
            try {
                const response = await fetch(request.url, { method: 'POST', headers: request.headers,
                    body: JSON.stringify(request.body), signal: AbortSignal.timeout(45000) })
                if (!response.ok) {
                    console.log(JSON.stringify({ stage: 'generation', model, httpStatus: response.status, ready: false,
                        reason: response.status === 402 ? '付款設定或預付餘額尚未就緒' : '供應商拒絕生成，未自動重試' }))
                    process.exitCode = 1
                    // Both models share a billing account; do not retry a payment/rate-limit failure.
                    if ([402, 429].includes(response.status)) break
                    continue
                }
                const result = parseProvider(model, await response.json())
                const ready = !!result.text.trim() && !result.partial && Number.isFinite(result.usage.input) && Number.isFinite(result.usage.output)
                console.log(JSON.stringify({ stage: 'generation', model, httpStatus: response.status, ready,
                    hasText: !!result.text.trim(), usage: result.usage, partial: result.partial }))
                if (!ready) process.exitCode = 1
            } catch (error) {
                console.log(JSON.stringify({ stage: 'generation', model, ready: false,
                    errorType: error.name, networkCode: error.cause?.code || null }))
                process.exitCode = 1
                break
            }
        }
    }
}
