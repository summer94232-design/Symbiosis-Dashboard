import { createHash } from 'node:crypto'
import { aiConfig } from '../netlify/lib/ai-policy.js'

const required = ['API_FIREBASE_PROJECT_ID','API_FIREBASE_SERVICE_ACCOUNT','API_ALLOWED_UIDS','GEMINI_API_KEY','AI_KMS_PROJECT_ID','AI_KMS_SERVICE_ACCOUNT']
const missing = required.filter(name => !process.env[name])
console.log(JSON.stringify({ configuredProviders: process.env.AI_ALLOWED_PROVIDERS || 'gemini',
    googleAccount: process.env.AI_GEMINI_ACCOUNT || '未核對', googleProject: process.env.AI_GEMINI_PROJECT || '未核對',
    pinnedKeyMatches: !!process.env.GEMINI_API_KEY && createHash('sha256').update(process.env.GEMINI_API_KEY).digest('hex') === process.env.AI_GEMINI_KEY_SHA256,
    models: aiConfig().models, missing, monthlyTwd: aiConfig().monthlyTwd, quotaConfirmed: aiConfig().quotaConfirmed }, null, 2))
if (process.argv.includes('--models') && process.env.GEMINI_API_KEY) {
    try {
        // Metadata only: no paid generation, no user notes, no Firebase reads/writes.
        const response = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000', {
            headers: { 'x-goog-api-key': process.env.GEMINI_API_KEY }, signal: AbortSignal.timeout(20000),
        })
        if (!response.ok) console.log(JSON.stringify({ modelMetadataHttpStatus: response.status }))
        else {
            const data = await response.json()
            const names = new Set((data.models || []).map(m => m.name?.replace(/^models\//,'')))
            console.log(JSON.stringify({ geminiModelMetadata: ['gemini-3.8-flash','gemini-3.5-flash-lite'].map(id => ({ id, listed: names.has(id) })) }))
        }
    } catch { console.log('Gemini 模型中繼資料查詢未完成；未執行生成，也未輸出金鑰或錯誤細節。') }
}
