// Read-only provider check: synthetic text, no generation or database access.
import { readFileSync } from 'node:fs'
import { parseEnv } from 'node:util'
import { createHash } from 'node:crypto'
import { countProviderTokens } from '../netlify/lib/ai-providers.js'
import { CONTEXT_TOOL } from '../netlify/lib/ai-intent.js'
const env = parseEnv(readFileSync('.env','utf8'))
if (env.AI_GEMINI_ACCOUNT !== 'summer94232@gmail.com' || env.AI_GEMINI_PROJECT !== 'gen-lang-client-0155504975'
    || createHash('sha256').update(env.GEMINI_API_KEY || '').digest('hex') !== env.AI_GEMINI_KEY_SHA256) throw Error('Approved account/key check failed')
const results = []
for (const model of ['gemini-3.8-flash','gemini-3.5-flash-lite']) {
    let httpStatus = null, networkCode = ''
    const countedFetch = async (...args) => {
        try {const response=await fetch(...args);httpStatus=response.status;return response}
        catch(error) {networkCode=/^[A-Z_0-9]{1,80}$/.test(error.cause?.code || '') ? error.cause.code : error.name;throw error}
    }
    try {
        const inputTokens = await countProviderTokens(model,'只處理測試文字，不搜尋。',[{role:'user',content:'這是合成的輸入計數測試，沒有私人資料。'}],countedFetch,env,{contextTool:CONTEXT_TOOL})
        results.push({model,ready:true,inputTokens})
    } catch { results.push({model,ready:false,httpStatus,networkCode,error:'Input token count endpoint failed; no generation called'}); process.exitCode=1 }
}
console.log(JSON.stringify({sameApprovedKey:true,generationCalls:0,databaseCalls:0,results},null,2))
