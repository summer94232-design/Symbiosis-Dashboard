// Opt-in paid model check using only the artificial notes defined in this file.
// No Firebase auth, production data, saved preferences, or deployment is used.
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { writeFileSync } from 'node:fs'
import { handleAi } from '../netlify/functions/ai-assistant.js'
import { retrieveNotes } from '../netlify/lib/ai-data.js'
import { callProvider } from '../netlify/lib/ai-providers.js'
import { taipeiDate, tokenCost } from '../netlify/lib/ai-policy.js'

if (!process.argv.includes('--generate')) {
    console.log('加上 --generate 才會呼叫兩個 Gemini 模型；所有內容均為人工測試資料。')
    process.exit(0)
}
const supplied = process.env
assert.equal(supplied.AI_GEMINI_ACCOUNT, 'summer94232@gmail.com')
assert.equal(supplied.AI_GEMINI_PROJECT, 'gen-lang-client-0155504975')
assert.equal(createHash('sha256').update(supplied.GEMINI_API_KEY).digest('hex'), supplied.AI_GEMINI_KEY_SHA256)
const env = Object.fromEntries(['AI_ENABLED','GEMINI_API_KEY','AI_GEMINI_PAID','AI_GEMINI_KEY_SHA256','AI_GEMINI_ACCOUNT','AI_GEMINI_PROJECT','AI_ALLOWED_PROVIDERS','AI_MONTHLY_TWD','AI_USD_TWD'].map(k=>[k,supplied[k]]))
assert.equal(env.AI_ALLOWED_PROVIDERS, 'gemini')
const uid = `artificial-notes-${randomUUID()}`
const samples = [
    { id:'beef-fast',title:'蔥炒牛肉',tags:['生活/料理'],body:'食材：牛肉、蔥、醬油。\n做法：熱鍋將牛肉與蔥快炒，加醬油調味。不加辣椒。\n準備 5 分鐘，烹調 10 分鐘，總時間 15 分鐘。' },
    { id:'beef-slow',title:'紅燒牛腱食譜',tags:['生活/料理'],body:'食材：牛腱、醬油、薑。\n做法：將牛腱煮熟，加入醬油燉煮。總時間 2 小時。' },
    { id:'chicken',title:'香煎雞胸食譜',tags:['生活/料理'],body:'食材：雞胸肉與鹽。做法：雞胸煎熟，總時間 20 分鐘。' },
    { id:'industry',title:'牛肉供應鏈研究',tags:['投資'],body:'牛肉進口商的市占率與營收分析，沒有料理步驟。' },
    { id:'book',title:'慢下來讀書紀錄',tags:['生活/書本/閱讀'],body:'書本紀錄：慢下來。書中談正念練習、放鬆與減輕壓力。每日花十分鐘閱讀與練習。' },
]
function memoryDb(rows = new Map()) {
    const log = []
    const snapshot = path => ({ exists:rows.has(path),data:()=>structuredClone(rows.get(path)) })
    return { rows,log,doc:path=>({path,get:async()=>{log.push(['read',path]);return snapshot(path)}}),
        async runTransaction(fn, options) {
            assert.equal(options.maxAttempts,1)
            const writes=[]
            const result=await fn({get:async ref=>{log.push(['read',ref.path]);return snapshot(ref.path)},set:(ref,value)=>writes.push([ref.path,structuredClone(value)])})
            for(const [path,value] of writes){rows.set(path,value);log.push(['write',path])}
            return result
        } }
}
const entries=samples.map(n=>({note:{id:n.id,title:n.title,type:'note'},texts:[n.title,...n.tags,n.body]}))
const rows=new Map([
    [`kmsSearch/${uid}/state/manifest`,{schema:1,status:'ready',totalNotes:entries.length,buckets:{a:{version:'synthetic',pages:['a1']}}}],
    [`kmsSearch/${uid}/fulltextShards/a1`,{version:'synthetic',data:gzipSync(JSON.stringify(entries)).toString('base64')}],
])
for(const n of samples){rows.set(`users/${uid}/notes/${n.id}`,{title:n.title,type:'note',hashtags:n.tags});rows.set(`users/${uid}/noteBodies/${n.id}`,{content:n.body})}
const kmsDB=memoryDb(rows),db=memoryDb()
const report={version:'v26.10.3.9',at:new Date().toISOString(),data:'artificial-only',realDatabaseReads:0,realDatabaseWrites:0,checks:[]}
let modelCalls=0,costTwd=0
const check=(name,passed,extra={})=>{report.checks.push({name,passed,...extra});console.log(JSON.stringify({name,passed,...extra}))}
async function chat(model,messages) {
    const response=await handleAi({httpMethod:'POST',headers:{},body:JSON.stringify({action:'chat',id:randomUUID(),model,messages,web:false})},
        {env,kmsDB,authorize:async()=>({uid,db}),retrieveNotes,callProvider:async(...args)=>{
            modelCalls++
            const result=await callProvider(...args)
            costTwd+=tokenCost(args[0],result.usage,taipeiDate(),Number(env.AI_USD_TWD)||35)||0
            if(result.functionCalls.length)console.log(JSON.stringify({artificialContextPlan:result.functionCalls}))
            return result
        },
            readPreferences:async()=>({items:[],revision:0}),writePreferences:()=>assert.fail('no preference writes'),retrieveInvest:()=>assert.fail('no investment queries')})
    const result=JSON.parse(response.body)
    if(response.statusCode!==200) console.log(JSON.stringify({httpStatus:response.statusCode,safeError:result.error}))
    assert.equal(response.statusCode,200)
    console.log(JSON.stringify({model,modelCalls:result.modelCalls,sources:result.sources.map(s=>s.id),understoodRequest:result.scope.understoodRequest,answer:result.answer.slice(0,1000)}))
    return result
}
try {
    if(!process.argv.includes('--reading-only')) {
    const ordinary=await chat('gemini-3.8-flash',[{role:'user',content:'這是對談驗證，請簡短回覆可以自然對談，不需要新資料。'}])
    check('ordinary-chat-one-round-no-kms',ordinary.modelCalls===1&&ordinary.scope.scanned===0&&!ordinary.billingPending)
    const question='我想用曾經記過的內容做一餐，以牛肉為主，不要雞肉。請只列符合條件的筆記名稱；找不到就說沒有。不要幫我保存任何偏好。'
    const meal=await chat('gemini-3.8-flash',[{role:'user',content:question}])
    const listed=meal.answer.split('\n').filter(line=>/^\s*(?:[*-]|\d+[.)])\s/.test(line)).join('\n') || meal.answer
    check('indirect-meal-request-understood-before-retrieval',meal.modelCalls===2&&meal.scope.scanned===5
        &&meal.sources.filter(s=>s.id.startsWith('beef-')).length===2&&/牛肉|牛腱|牛排/.test(meal.scope.understoodRequest)
        &&/蔥炒牛肉/.test(meal.answer)&&/紅燒牛腱/.test(meal.answer)&&!/香煎雞胸|牛肉供應鏈/.test(listed)&&!meal.billingPending,
        {candidateNotes:meal.sources.length})
    const evidence=meal.sources.map(s=>`${s.title}：${s.passages.map(p=>p.quote).join('\n')}`).join('\n')
    const follow=await chat('gemini-3.8-flash',[{role:'user',content:question},
        {role:'assistant',content:`${meal.answer}\n上輪實際提供的摘錄：\n${evidence}`},
        {role:'user',content:'那有沒有更省事、半小時內能做完的？不確定花多久就直接說無法確認，不要另存偏好。'}])
    check('follow-up-retains-constraints-and-reuses-known-context',!!follow.answer.trim()&&/蔥炒牛肉/.test(follow.answer)&&!follow.billingPending
        &&(follow.modelCalls===1||/牛肉|牛腱|牛排/.test(follow.scope.understoodRequest)),{modelCalls:follow.modelCalls})
    }
    if(!process.argv.includes('--main-only')) {
    const reading=await chat('gemini-3.5-flash-lite',[{role:'user',content:'我之前記過一些書本，現在想找能幫我舒緩壓力的內容。請從我的紀錄裡找，找不到就說沒有，簡短回答；不要另存偏好。'}])
    check('lite-reading-intent-same-account',reading.modelCalls===2&&reading.scope.scanned===5&&reading.sources.some(s=>s.id==='book')
        &&/書|閱讀/.test(reading.scope.understoodRequest)&&!reading.billingPending&&!reading.currentFactsRequested)
    }
    check('no-artificial-note-writes',!kmsDB.log.some(([op])=>op==='write'))
    report.passed=report.checks.every(c=>c.passed)
    if(!report.passed)process.exitCode=1
} catch {report.passed=false;process.exitCode=1}
finally {
    Object.assign(report,{modelCalls,costTwd})
    console.log(JSON.stringify({passed:report.passed,modelCalls,costTwd,realDatabaseReads:0,realDatabaseWrites:0}))
    const scope=process.argv.includes('--main-only')?'main':process.argv.includes('--reading-only')?'lite':'all'
    writeFileSync(`log/ai-intent-synthetic-${scope}-2026-10-03.json`,JSON.stringify(report,null,2)+'\n')
}
