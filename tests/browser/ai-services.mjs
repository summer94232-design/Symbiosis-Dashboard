import { investAuth, kmsAuth } from './services.mjs'
export * from './services.mjs'
export const aiFixture = { mode: 'normal', calls: [], pending: [], preferences: [], revision: 0 }
const authCallbacks = new Map()
investAuth.currentUser.email = 'fixture@example.invalid'
kmsAuth.currentUser.email = 'fixture@example.invalid'
for (const auth of [investAuth, kmsAuth]) auth.onAuthStateChanged = cb => { authCallbacks.set(cb, auth); cb(auth.currentUser); return () => authCallbacks.delete(cb) }
export function switchAiFixture() {
    const uid = investAuth.currentUser.uid === 'fixture-A' ? 'fixture-B' : 'fixture-A'
    investAuth.currentUser = { uid, email: `${uid}@example.invalid`, getIdToken: async () => 'fixture-token' }
    kmsAuth.currentUser = { uid, email: `${uid}@example.invalid` }
    authCallbacks.forEach((auth, cb) => cb(auth.currentUser))
}
const status = () => ({ config: { enabled: true, monthlyTwd: 150, dailyTwd:10,turnTwd:1,researchTwd:5,webBudgetSafe:false,quotaConfirmed: false, models: [
    { id:'gemini-3.8-flash',label:'Gemini 3.8 Flash',available:true }, { id:'gemini-3.5-flash-lite',label:'Gemini 3.5 Flash-Lite',available:true },
    { id:'gpt-6.1-sol',label:'GPT-6.1 Sol',available:false }, { id:'claude-sonnet-5-5',label:'Claude Sonnet 5.5',available:false },
 ] }, google: { verified:true,account:'隔離測試（無 Google 連線）',project:'fixture-project' },
 preferences: { items:aiFixture.preferences,revision:aiFixture.revision },
 budget: { estimatedTwd:1.2,reservedTwd:0,remainingTwd:148.8,monthlyTwd:150,day:'2026-10-04',daily:{investReads:48,investWrites:3,kmsReads:45,kmsWrites:0},limits:{investReads:1000,investWrites:400,kmsReads:1000,kmsWrites:400} } })
export function installAiFixture() {
    globalThis.fetch = async (url, options = {}) => {
        if (url !== '/.netlify/functions/ai-assistant') throw new Error('隔離驗收禁止其他網路請求')
        const body = JSON.parse(options.body)
        aiFixture.calls.push({ action: body.action, model:body.model, uid:investAuth.currentUser.uid,
            historyCharacters:(body.messages||[]).reduce((n,m)=>n+m.content.length,0),updateMemory:!!body.updateMemory })
        if (body.action === 'status') {
            if (aiFixture.mode === 'status-delay') await new Promise(resolve => aiFixture.pending.push(resolve))
            if (aiFixture.mode === 'status-fail') return Response.json({error:'登入驗證服務連線失敗，請檢查後端網路後重試'},{status:503})
            return Response.json(status())
        }
        if (body.action === 'preferences') { aiFixture.preferences=body.items;aiFixture.revision++;return Response.json(status()) }
        if (body.action === 'note') return Response.json({noteId:`ai-${body.id}`})
        if (aiFixture.mode === 'fail') return Response.json({error:'隔離測試：API 失敗，請手動重試'},{status:503})
        if (aiFixture.mode === 'delay') await new Promise(resolve => aiFixture.pending.push(resolve))
        if (body.action === 'helper') return Response.json({...status(),answer:body.messages[0].content.includes('hashtag')?'["生活/食譜"]':'["learning"]',partial:false})
        if (aiFixture.mode === 'reading' || aiFixture.mode === 'recovery') {
            const round=aiFixture.calls.filter(c=>c.action==='chat').length
            const started=!!body.researchToken,complete=started && round>2
            const recovering=aiFixture.mode==='recovery' && round===1
            return Response.json({...status(),answer:recovering?'已整理 24/24 段，尚未完成綜合回答。已讀摘要已保留，可稍後手動重試。':!started?'先提供相關段落。這是部分摘錄；如需長篇研究，可分批整理原文。':complete?'已完成示範範圍的分段摘要。2028 年仍是預期，末段指出訂單延後的風險，最新現況待查證。[N1]':'目前已整理 6/24 段，可按「繼續整理」接續。這仍是部分閱讀，尚未形成完整研究結論。',
                sources:[{ref:'N1',id:'future',title:'CPO 產業長篇研究（示範）',savedAt:'2025-03-01',updatedAt:'2026-10-04',passages:[{paragraph:24,quote:'2028 年預期尚未確認，注意量產延後風險。'}]}],citations:[],
                scope:{scanned:200,matched:12,provided:1,...(recovering?{summarizedChunks:24,totalChunks:24,readCharacters:70000,totalCharacters:70000,includedSummaryChunks:24,complete:true}:started?{summarizedChunks:complete?24:6,totalChunks:24,readCharacters:complete?70000:18000,totalCharacters:70000,includedSummaryChunks:complete?24:6,reusedChunks:complete?6:0,complete}: {unreadCandidates:6})},
                research:{token:'fixture-reading-token',offer:!started && !recovering,complete:complete || recovering,canContinue:!complete,limitTwd:5,costTwd:!started?.1:complete?.8:.45,remainingTwd:!started?4.9:complete?4.2:4.55,synthesisPending:recovering,reason:recovering?'綜合回答未完成；已讀摘要仍可接續使用。':''},
                usage:{input:complete?12000:4500,output:1200,thoughts:200,cached:complete?8000:0,searches:0},noteSummaries:[],
                costTwd:started?.35:.1,webVerified:false,currentFactsRequested:true,webSearches:0,partial:recovering,recovery:recovering?'綜合回答未完成，已讀摘要已保留，可稍後手動重試。':'',billingPending:false,preference:null})
        }
        if (aiFixture.mode === 'memory') return Response.json({ ...status(),
            answer:'這是長聊示範：你要在 2027 年研究筆記中對 2028 年的發展預期。\n\n'+
                '保留的條件：2025 年保存的研究可作背景，最後查證日期未知；2024 年已過期的發展不能當成新的投資機會。這些是示範假設，沒有實際投資結論。\n\n'.repeat(12)+
                '接下來可以延續討論，不必開新對話。',
            conversationMemory:body.updateMemory?'目前目標：2027 年研究 2025 年筆記中對 2028 年的發展預期；原始資料日期與最後查證日期未知。2024 年已過期的發展不能當成新機會。需查證是否已發生、延後或反映在價格；目前沒有投資結論。來源：散熱產業研究／future。':null,
            sources:[],citations:[],scope:{scanned:0,matched:0,provided:0,reason:'長聊示範，不搜尋筆記'},webVerified:false,currentFactsRequested:false,
            webSearches:0,partial:false,billingPending:false,costTwd:0,preference:null })
        if (aiFixture.mode === 'format') return Response.json({ ...status(),
            answer:'#### 回覆格式示範\n\n**重點**：以正常排版顯示，不改動原始筆記。\n\n* 食譜：依食材整理\n* 書本：依主題整理\n\n1. 先理解需求\n2. 再找相關資料\n\n| 內容 | 條件 | 狀態 |\n| --- | --- | --- |\n| 料理筆記 | 半小時內 | 依原文確認 |\n| 研究筆記 | 發展時間 | 未知就保留未知 |\n\n字面符號仍保留：`A*STAR`、`#標籤`、2 * 3 = 6。[N1]\n\n> 這是示範內容，不使用私人資料。\n\n[示範來源](https://example.invalid/format)',
            sources:[],citations:[],scope:{scanned:0,matched:0,provided:0,reason:'格式測試，不搜尋筆記'},
            webVerified:false,currentFactsRequested:false,webSearches:0,partial:false,billingPending:false,costTwd:0,preference:null,searchSuggestions:'' })
        if (/牛肉/.test(body.messages?.at(-1)?.content || '')) return Response.json({ ...status(),
            answer:'示範：符合牛肉條件的筆記是「紅燒牛腱」。牛腱屬於牛肉，番茄炒蛋未符合食材條件，因此不列入。\n\n[N1] 第 1–2 段：牛腱切塊，加入醬油，小火燉煮。',
            sources:[{ref:'N1',id:'beef-demo',title:'紅燒牛腱（示範）',savedAt:null,updatedAt:null,passages:[{paragraph:1,quote:'牛腱切塊。'},{paragraph:2,quote:'加入醬油，小火燉煮。'}]}],
            citations:[],scope:{scanned:48,matched:1,provided:1,terms:['牛肉','食譜']},webVerified:false,currentFactsRequested:false,webSearches:0,
            partial:false,billingPending:false,costTwd:0,preference:null,searchSuggestions:'' })
        return Response.json({ ...status(), answer:'可以將這份筆記保留為研究假設。**2025 年記錄的 2028 年預期**，在 2027 年仍值得追蹤，但需確認訂單時程與是否已反映在股價。\n\n其中「2024 年開始成長」屬於已過期的發展時間，不能直接當成 2026 年的新機會。',
            sources:[{ref:'N1',id:'future',title:'散熱產業研究',savedAt:'2025-03-01',updatedAt:'2026-01-02',passages:[{paragraph:2,quote:'2025 年研究：預期散熱產業在 2028 年帶來新訂單。'}]}],
            citations:[{url:'https://example.invalid/fixture',title:'隔離查證來源'}],scope:{scanned:48,matched:3,provided:1,terms:['散熱']},
            webVerified:false,currentFactsRequested:true,webSearches:0,partial:false,billingPending:false,costTwd:0.1,
            preference:{text:'回答先呈現結論，再附來源與反對證據',kind:'candidate'},searchSuggestions:'' })
    }
}
