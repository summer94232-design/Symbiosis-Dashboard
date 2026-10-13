// Opt-in live Gemini acceptance with synthetic notes and the real shared budget.
// Never changes provider settings, creates real notes, or prints credentials/UIDs.
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { mkdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs'
import { getAuth } from 'firebase-admin/auth'
import { getFirestore } from 'firebase-admin/firestore'
import { getProtectedApp } from '../netlify/lib/api-access.js'
import { handleAi } from '../netlify/functions/ai-assistant.js'
import { reserveAi, settleAi, budgetView } from '../netlify/lib/ai-budget.js'
import { aiConfig, taipeiDate } from '../netlify/lib/ai-policy.js'
import { callProvider } from '../netlify/lib/ai-providers.js'
import { compile, read } from '../tests/helpers/compile.mjs'

const supplied = process.env
assert.equal(supplied.AI_GEMINI_ACCOUNT, 'summer94232@gmail.com')
assert.equal(supplied.AI_GEMINI_PROJECT, 'gen-lang-client-0155504975')
assert.equal(supplied.AI_ALLOWED_PROVIDERS, 'gemini')
assert.equal(createHash('sha256').update(supplied.GEMINI_API_KEY || '').digest('hex'), supplied.AI_GEMINI_KEY_SHA256)
const config = aiConfig(supplied)
assert.equal(config.monthlyTwd, 150)
assert.ok(config.models.filter(m => m.available).every(m => m.id.startsWith('gemini')))
const date = taipeiDate(), maxTwd = 3
const generate = process.argv.includes('--generate')
const chosen = process.argv.find(arg => arg.startsWith('--case='))?.slice(7) || 'all'
assert.ok(['all','conversation','helpers','reading','reading-resume','reading-reuse'].includes(chosen))
mkdirSync('.codex-tmp', {recursive:true}); mkdirSync('log', {recursive:true})
const checkpointPath = `.codex-tmp/ai-live-${date}.json`
const checkpoint = existsSync(checkpointPath) ? JSON.parse(readFileSync(checkpointPath,'utf8')) : { attempts:[], scenarios:{}, reading:null }
const save = () => writeFileSync(checkpointPath,JSON.stringify(checkpoint,null,2)+'\n')
const reservedOrSpent = () => checkpoint.attempts.reduce((sum,a) => sum + (a.costTwd ?? a.hold ?? 0),0)
const report = {at:new Date().toISOString(),version:read('src/lib/appVersion.ts').match(/v\d+\.\d+\.\d+\.\d+/)?.[0],
    input:'synthetic-notes-only',sharedMonthlyLimitTwd:150,validationLimitTwd:maxTwd,checks:[],requests:[],privateNotesRead:0,privateNotesWritten:0}
let currentCase = '', uid, db
const check = (name,passed,details={}) => {
    const item = {name,passed,...details};report.checks.push(item);console.log(JSON.stringify(item))
    assert.ok(passed, `Acceptance failed: ${name}`)
}
const samples = [
    {id:'beef-fast',title:'蔥炒牛肉',tags:['生活/料理'],body:'食材：牛肉、蔥、醬油。\n做法：牛肉與蔥快炒，加醬油調味，不加辣椒。準備5分鐘、烹調10分鐘，總時間15分鐘。'},
    {id:'beef-slow',title:'紅燒牛腱食譜',tags:['生活/料理'],body:'食材：牛腱、薑、醬油。牛腱切塊燉煮2小時，肉軟後起鍋。'},
    {id:'chicken',title:'香煎雞胸食譜',tags:['生活/料理'],body:'雞胸肉抹鹽煎熟，20分鐘完成。沒有牛肉。'},
    {id:'business',title:'肉品公司研究',tags:['投資'],body:'牛肉進口商的市占率與營收分析，沒有食譜或料理步驟。'},
    {id:'book',title:'慢下來讀書紀錄',tags:['生活/閱讀'],body:'這本書介紹正念練習與壓力管理，每天練習十分鐘。'},
]
let longText = '石榴計畫研究紀錄。保存日期2025年，來源日期與最後查證日期未知；所有內容均為人工驗收資料。\n'
for(let section=1;longText.length<20500;section++) {
    longText+=`第${section}節 石榴計畫測試觀察\n`
    longText+=`此段只討論第${section}批試驗樣品。石榴計畫原先預期2028年量產，但這是尚未查證的假設。成本需要同時考量散熱、材料與封裝良率；試驗小批數據不足以推論正式量產良率。記錄日期不是驗證日期，歷史研究只作為背景。\n`.repeat(7)
}
longText+='最終稽核結論：石榴計畫原先2028年量產的假設已被本篇最後測試否定，預估時程延後至2030年，而且2030年仍待客戶驗證，不能當成確定訂單。最後反證代碼是「紅橋-73」。此文沒有任何最新市場報價。\n'
samples.push({id:'pomegranate-long',title:'石榴計畫長篇研究',tags:['研究/產業'],body:longText})

function syntheticKms(owner) {
    const entries=samples.map(n=>({note:{id:n.id,title:n.title,type:'note'},texts:[n.title,...n.tags,n.body]}))
    const rows=new Map([
        [`kmsSearch/${owner}/state/manifest`,{schema:1,status:'ready',totalNotes:entries.length,buckets:{a:{version:'acceptance',pages:['a1']}}}],
        [`kmsSearch/${owner}/fulltextShards/a1`,{version:'acceptance',data:gzipSync(JSON.stringify(entries)).toString('base64')}],
    ])
    for(const note of samples) {
        rows.set(`users/${owner}/notes/${note.id}`,{title:note.title,type:'note',hashtags:note.tags,createdAt:'2025-01-01T00:00:00Z'})
        rows.set(`users/${owner}/noteBodies/${note.id}`,{content:note.body})
    }
    return {doc:path=>({get:async()=>({exists:rows.has(path),data:()=>structuredClone(rows.get(path))})})}
}
let dependencies
async function call(action,model,messages,extra={}) {
    // Respect the deployed rate limiter; never reset usage or bypass a denied request.
    const before=(await db.doc('aiUsage/control').get()).data() || {}
    if(before.minute===Math.floor(Date.now()/60000) && before.calls>=5) {
        const ms=60000-Date.now()%60000+250
        console.log(JSON.stringify({waitingForMinuteLimit:true,milliseconds:ms}))
        await new Promise(resolve=>setTimeout(resolve,ms))
    }
    assert.ok(reservedOrSpent()<maxTwd-.1,'Validation budget exhausted; no generation started')
    const input={action,id:randomUUID(),model,messages,web:false,...extra}
    const response=await handleAi({httpMethod:'POST',headers:{},body:JSON.stringify(input)},dependencies)
    const result=JSON.parse(response.body)
    const item={case:currentCase,model,httpStatus:response.statusCode,costTwd:result.costTwd ?? null,
        billingPending:result.billingPending,modelCalls:result.modelCalls,scope:result.scope,
        answer:result.answer?.slice(0,3500),error:result.error,usage:result.usage}
    report.requests.push(item)
    console.log(JSON.stringify({case:currentCase,model,httpStatus:response.statusCode,costTwd:result.costTwd,
        billingPending:result.billingPending,modelCalls:result.modelCalls,read:result.scope?.summarizedChunks,total:result.scope?.totalChunks,error:result.error}))
    if(result.research && currentCase.startsWith('reading-')) {
        checkpoint.reading={token:result.research.token,noteSummaries:result.noteSummaries || [],result}
        save()
    }
    assert.equal(response.statusCode,200,'Live request rejected; inspect safe report before retrying')
    assert.equal(result.billingPending,false,'Unknown billing stops acceptance')
    assert.ok(!result.partial,'Incomplete generation stops acceptance')
    return result
}
async function conversation() {
    currentCase='ordinary-flash'
    const plain=await call('chat','gemini-3.8-flash',[{role:'user',content:'這是一般對話驗收，不查筆記、不聯網、不儲存偏好。請只回覆「可以自然對話」。'}])
    check('ordinary-generation-and-usage',plain.modelCalls===1 && plain.scope.scanned===0 && /可以自然對話/.test(plain.answer))
    currentCase='recipe-intent'
    const question='請從我保存的筆記找一道半小時內完成、不辣的牛肉料理；不要雞肉，也不要肉品投資研究。只列出最符合的一則筆記名稱和需要幾分鐘，不確定就明說。不要儲存偏好。'
    const meal=await call('chat','gemini-3.8-flash',[{role:'user',content:question}])
    check('intent-retrieval-and-condition-filter',meal.scope.scanned===samples.length && /蔥炒牛肉/.test(meal.answer) && /15/.test(meal.answer) && !/香煎雞胸|紅燒牛腱/.test(meal.answer),{sources:meal.sources.map(s=>s.id)})
    currentCase='followup-and-memory-lite'
    const {buildAiHistory}=compile(read('src/lib/aiConversation.ts'))
    const history=buildAiHistory([{id:'first-question',role:'user',content:question},{id:'first-answer',role:'assistant',content:meal.answer,reply:meal},
        {id:'follow-up',role:'user',content:'延續剛剛選的那道菜，幫我把已確認的食材、時間及不辣條件簡短整理。沒提供的份量不要猜；不要儲存長期偏好。'}])
    const follow=await call('chat','gemini-3.5-flash-lite',history.messages,{updateMemory:true})
    check('lite-context-and-automatic-memory',/蔥炒牛肉/.test(follow.answer) && /15/.test(follow.answer) && typeof follow.conversationMemory==='string' && /牛肉/.test(follow.conversationMemory),{memoryCharacters:follow.conversationMemory?.length})
}
async function helpers() {
    const helpers=compile(read('src/lib/gemini.ts'),{authenticatedFetch:async(_url,_session,options)=>{
        const payload=JSON.parse(options.body)
        const result=await call(payload.action,payload.model,payload.messages)
        return {json:async()=>result}
    }})
    currentCase='real-tag-helper'
    const tags=await helpers.generateHashtags(samples[0].body,samples[0].title,['生活/料理','投資/台股','生活/閱讀'])
    check('frontend-tag-helper-parses-real-output',tags.length>0 && tags.length<=6 && tags.some(t=>/料理|牛肉|食譜/.test(t)),{tags})
    currentCase='real-link-helper'
    const links=await helpers.findRelatedNotes('牛肉晚餐構想','想找牛肉料理的相關做法，排除雞肉與投資報告。',samples.slice(0,5).map(n=>({id:n.id,title:n.title,content:n.body})))
    check('frontend-related-note-helper-validates-real-ids',links.length>0 && links.includes('beef-fast') && !links.includes('business') && !links.includes('chicken'),{links})
}
async function reading(resume=false) {
    if(!resume) {
        currentCase='reading-offer'
        const first=await call('chat','gemini-3.8-flash',[{role:'user',content:'請找「石榴計畫長篇研究」筆記，初步整理量產時程與反對證據；資料很多時先給重點，我之後會按完整整理。原始來源與查證日期不明時請明說，不要查投資帳戶或儲存偏好。'}])
        check('real-retrieval-offers-complete-reading',first.sources.some(s=>s.id==='pomegranate-long') && first.research?.offer===true && first.research.canContinue)
    }
    assert.ok(checkpoint.reading?.token,'A saved reading offer is required')
    let last=checkpoint.reading.result
    for(let batch=0;batch<4 && !last.research?.complete;batch++) {
        const previous=checkpoint.reading.noteSummaries.length
        currentCase=`reading-batch-${previous}`
        last=await call('chat',previous ? 'gemini-3.8-flash':'gemini-3.5-flash-lite',
            [{role:'user',content:'接續完整整理石榴計畫，保留時程、反對證據、未知日期與最後限制。'}],
            {researchToken:checkpoint.reading.token,noteSummaries:checkpoint.reading.noteSummaries})
        check(`reading-progress-${previous}`,last.scope.summarizedChunks>previous && last.scope.reusedChunks===previous,
            {read:last.scope.summarizedChunks,total:last.scope.totalChunks})
    }
    check('long-note-complete-including-final-counterevidence',last.research?.complete===true && last.scope.readCharacters>=20500
        && /2030/.test(last.answer) && /延後/.test(last.answer) && /紅橋.?73/.test(last.answer),
        {characters:last.scope.readCharacters,chunks:last.scope.summarizedChunks,costTwd:last.research?.costTwd})
    const summaries=checkpoint.reading.noteSummaries.map(token=>JSON.parse(Buffer.from(token.split('.')[0],'base64url').toString('utf8')).value.summary)
    check('summary-does-not-upgrade-a-tentative-forecast',summaries.some(s=>/2030/.test(s)&&/預估|預期/.test(s))
        && summaries.every(s=>!/已正式延後|正式延後至/.test(s)))
}
async function readingReuse() {
    assert.ok(checkpoint.reading?.result.research?.complete,'Complete reading is required before reuse')
    currentCase='reading-cache-reuse'
    const model=process.argv.includes('--flash')?'gemini-3.8-flash':'gemini-3.5-flash-lite'
    const result=await call('chat',model,[{role:'user',content:'接續整理。'}],{researchToken:checkpoint.reading.token,noteSummaries:checkpoint.reading.noteSummaries})
    check('cached-reading-skips-all-summary-and-planning-calls',result.modelCalls===1 && result.scope.reusedChunks===result.scope.totalChunks
        && /2030/.test(result.answer) && /紅橋.?73/.test(result.answer),{reused:result.scope.reusedChunks})
    check('forecast-keeps-original-certainty',/預估|預期/.test(result.answer) && !/已正式(?:\*\*)?延後|正式(?:\*\*)?延後至/.test(result.answer),{model})
}
try {
    const app=getProtectedApp()
    const user=await getAuth(app).getUserByEmail(supplied.AI_GEMINI_ACCOUNT)
    assert.ok((supplied.API_ALLOWED_UIDS||'').split(',').map(v=>v.trim()).includes(user.uid),'Approved account must already be authorized')
    assert.equal(user.disabled,false)
    uid=user.uid;db=getFirestore(app)
    const initial=(await db.doc('aiUsage/control').get()).data() || {}
    const initialBudget=budgetView(initial,config)
    console.log(JSON.stringify({preflight:true,approvedAccount:true,approvedProject:true,monthlyLimitTwd:config.monthlyTwd,
        monthRemainingTwd:initialBudget.remainingTwd,validationReservedOrSpentTwd:reservedOrSpent(),generate,case:chosen}))
    if(generate) {
        dependencies={env:supplied,authorize:async()=>({uid,db}),kmsDB:syntheticKms(uid),
            readPreferences:async()=>({items:[],revision:0}),
            writePreferences:()=>assert.fail('Acceptance must not change real preferences'),
            retrieveInvest:()=>assert.fail('Acceptance must not read private investment records'),
            reserve:async(realDb,owner,id,hold,operations,cfg,task)=>{
                const allowed=Math.min(hold,Math.max(0,maxTwd-reservedOrSpent()))
                if(hold>0 && allowed<.1)throw Error('Validation budget exhausted')
                const ledger=await reserveAi(realDb,owner,id,allowed,operations,cfg,task)
                if(hold>0){checkpoint.attempts.push({id,case:currentCase,hold:ledger.reservations[id].hold,costTwd:null});save()}
                return ledger
            },
            settle:async(realDb,owner,id,amount,usage)=>{
                const ledger=await settleAi(realDb,owner,id,amount,usage)
                const attempt=checkpoint.attempts.find(a=>a.id===id)
                if(attempt && ledger){attempt.costTwd=amount;save()}
                return ledger
            },
            callProvider:async(...args)=>callProvider(...args),
        }
        for(const [name,run] of [['conversation',conversation],['helpers',helpers],['reading',()=>reading()],['reading-resume',()=>reading(true)],['reading-reuse',readingReuse]]) {
            if(chosen!=='all' && chosen!==name || chosen==='all' && (name==='reading-resume' || checkpoint.scenarios[name]))continue
            await run();checkpoint.scenarios[name]=true;save()
        }
    }
    report.passed=true
} catch(error) {
    report.passed=false;process.exitCode=1
    report.failure=error?.code==='ERR_ASSERTION' ? error.message.split('\n')[0] : 'Verification stopped; no automatic retry. Check safe request summaries.'
    console.log(JSON.stringify({passed:false,case:currentCase,error:report.failure}))
} finally {
    report.validationReservedOrSpentTwd=Math.round(reservedOrSpent()*1000)/1000
    report.pending=checkpoint.attempts.filter(a=>a.costTwd===null).map(a=>({case:a.case,hold:a.hold}))
    const path=`log/ai-live-${date}-${report.at.replace(/[:.]/g,'-')}.json`
    writeFileSync(path,JSON.stringify(report,null,2)+'\n')
    console.log(JSON.stringify({passed:report.passed,checks:report.checks.length,validationReservedOrSpentTwd:report.validationReservedOrSpentTwd,pending:report.pending,report:path}))
}
