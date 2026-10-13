import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { compile, read } from './helpers/compile.mjs'
const {createLatestReads}=compile(read('src/lib/latestReads.ts'))
function syncHarness(){
 const states=[],listeners=[],timers=new Map(),invalidated=[];let authChanged,uid='a',sequence=0
 const bindings={require:createRequire(import.meta.url),createContext:()=>({Provider:'div'}),useState:value=>{const index=states.length;states.push(value);return [value,next=>{states[index]=typeof next==='function'?next(states[index]):next}]},useRef:value=>({current:value}),useMemo:fn=>fn(),useEffect:fn=>fn(),
  investDB:{},userCol:(_,name)=>uid+'/'+name,investAuth:{onAuthStateChanged:fn=>{authChanged=fn;fn({uid});return ()=>{}}},
  onSnapshot:(ref,options,next,error)=>{assert.equal(options.includeMetadataChanges,true);listeners.push({ref,next,error});return ()=>{}},
  setTimeout:fn=>{const id=++sequence;timers.set(id,fn);return id},clearTimeout:id=>timers.delete(id),
 }
 for(const name of ['invalidateQuoteUniverse','invalidateCalendarEvents','invalidateTasks','invalidateTaskProjects','invalidateAssetSnapshots','invalidateCashflow','invalidateDividends','invalidateTrades'])bindings[name]=()=>invalidated.push(name)
 compile(read('src/InvestSyncContext.tsx'),bindings).InvestSyncProvider({children:null})
 return {states,listeners,invalidated,flush:()=>{const pending=[...timers.values()];timers.clear();pending.forEach(fn=>fn())},switch:()=>{uid='b';authChanged({uid})}}
}
const syncSnapshot=(fromCache,hasPendingWrites=false,changed=false)=>({metadata:{fromCache,hasPendingWrites},docChanges:()=>changed?[{}]:[]})
test('sync status waits for server acknowledgement and metadata-only changes do not trigger reload loops',()=>{
 const h=syncHarness()
 h.listeners.forEach(l=>l.next(syncSnapshot(true)));h.flush();assert.equal(h.states[2],'connecting')
 const version=h.states[1]
 h.listeners.forEach(l=>l.next(syncSnapshot(false)));h.flush();assert.equal(h.states[2],'live');assert.equal(h.states[1],version)
 h.listeners[0].next(syncSnapshot(false,true));assert.equal(h.states[2],'connecting')
})
test('sync account switch clears pending old-account refresh and ignores detached listeners',()=>{
 const h=syncHarness(),old=h.listeners[0]
 old.next(syncSnapshot(false,true,true));h.switch();const count=h.invalidated.length
 old.next(syncSnapshot(false,false,true));h.flush()
 assert.equal(h.states[1],0);assert.equal(h.invalidated.length,count)
 assert.ok(h.listeners.some(l=>l.ref==='b/calendarWatchList'));assert.ok(h.listeners.some(l=>l.ref==='b/investorMeetingOverrides'))
})
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});return {promise,resolve,reject}}
test('calendar latest read wins when old month succeeds or fails after the new month',async()=>{
 for(const failed of [false,true]){
 const reader=createLatestReads(),old=deferred(),seen=[],states=[]
 const status=(...args)=>states.push(args)
 const first=reader.run('meetings',()=>old.promise,v=>seen.push(v),status,()=>{})
 await reader.run('meetings',async()=> 'new month',v=>seen.push(v),status,()=>{})
 if(failed)old.reject(Error('old failure'));else old.resolve('old month')
 assert.equal(await first,false);assert.deepEqual(seen,['new month']);assert.deepEqual(states.at(-1),['meetings',false,''])
 }
})
test('calendar failure retains previous data; retry releases loading and publishes new data',async()=>{
 const reader=createLatestReads(),seen=['previous'],states=[]
 assert.equal(await reader.run('events',async()=>{throw Error('offline')},v=>seen.push(v),(...args)=>states.push(args),()=>{}),false)
 assert.deepEqual(seen,['previous']);assert.deepEqual(states.at(-1),['events',false,'offline'])
 assert.equal(await reader.run('events',async()=> 'fresh',v=>seen.push(v),(...args)=>states.push(args),()=>{}),true)
 assert.deepEqual(seen,['previous','fresh']);assert.deepEqual(states.at(-1),['events',false,''])
})
test('calendar unmount and account change cannot publish pending private data',async()=>{
 for(const cancel of [true,false]){
 const reader=createLatestReads(),pending=deferred(),seen=[]
 const result=reader.run('events',()=>pending.promise,v=>seen.push(v),()=>{},()=>{if(!cancel)throw Error('account changed')})
 if(cancel)reader.cancel();pending.resolve('private');await result;assert.deepEqual(seen,[])
 }
})
function quotaDb(){
 const rows=new Map();let queue=Promise.resolve()
 return {rows,doc:path=>path,runTransaction:fn=>{
  const work=queue.then(async()=>{const writes=[];const result=await fn({get:async ref=>({data:()=>structuredClone(rows.get(ref))}),set:(ref,value)=>writes.push([ref,value])});writes.forEach(([k,v])=>rows.set(k,v));return result})
  queue=work.catch(()=>{});return work
 }}
}
function accessHarness(){
 const db=quotaDb(),state={uid:'a',error:null,verified:0,config:{API_FIREBASE_PROJECT_ID:'demo',API_FIREBASE_SERVICE_ACCOUNT:'{"project_id":"demo"}',API_ALLOWED_UIDS:'a,b'}}
 const mod=compile(read('netlify/lib/api-access.js'),{createHash,process:{env:state.config},cert:v=>v,getApps:()=>[],initializeApp:()=>({}),getFirestore:()=>db,getAuth:()=>({verifyIdToken:async(token,revoked)=>{state.verified++;assert.equal(token,'valid');assert.equal(revoked,true);if(state.error)throw state.error;return {uid:state.uid}}})})
 return {db,state,mod}
}
const request={httpMethod:'GET',headers:{authorization:'Bearer valid'}}
test('API rejects missing token, wrong method, missing configuration and unauthorized UID before upstream work',async()=>{
 const {mod,state,db}=accessHarness()
 assert.equal((await mod.authorizeApi({httpMethod:'GET'},'news')).statusCode,401)
 assert.equal((await mod.authorizeApi({...request,httpMethod:'POST'},'news')).statusCode,405)
 state.config.API_ALLOWED_UIDS='';assert.equal((await mod.authorizeApi(request,'news')).statusCode,503)
 state.config.API_ALLOWED_UIDS='b';assert.equal((await mod.authorizeApi(request,'news')).statusCode,403)
 assert.equal(db.rows.size,0)
})
test('API expired/revoked/wrong-project token fails closed; verifier outage does not spend quota',async()=>{
 const {mod,state,db}=accessHarness()
 for(const code of ['auth/id-token-expired','auth/id-token-revoked','auth/argument-error','auth/user-disabled']){
 state.error={code};assert.equal((await mod.authorizeApi(request,'news')).statusCode,401)
 }
 state.error={code:'auth/internal-error'};assert.equal((await mod.authorizeApi(request,'news')).statusCode,503);assert.equal(db.rows.size,0)
})
test('API quota is shared across independent instances and concurrent requests',async()=>{
 const db=quotaDb(),a=accessHarness().mod,b=accessHarness().mod,now=1000
 const results=await Promise.all(Array.from({length:12},(_,i)=>(i%2?a:b).consumeQuota(db,'a','news',1,now)))
 assert.equal(results.filter(n=>n===0).length,6);assert.equal(results.filter(n=>n>0).length,6)
 assert.equal(await a.consumeQuota(db,'a','news',1,61000),0)
})
test('API daily account and global quotas reset at the next UTC day without adding unbounded documents',async()=>{
 const {mod,db}=accessHarness()
 assert.equal(await mod.consumeQuota(db,'a','foreign',120,1000),0)
 assert.ok(await mod.consumeQuota(db,'a','foreign',1,1001)>0)
 const global=db.rows.get('apiUsage/foreign_global');global.dayUnits=10000
 assert.ok(await mod.consumeQuota(db,'b','foreign',1,61000)>0)
 assert.equal(await mod.consumeQuota(db,'b','foreign',1,86400001),0)
 assert.equal(db.rows.size,3)
})
test('API quota denial returns 429 Retry-After and quota-store failure returns 503',async()=>{
 const {mod,db}=accessHarness()
 for(let i=0;i<6;i++)assert.equal(await mod.authorizeApi(request,'news'),null)
 const denied=await mod.authorizeApi(request,'news');assert.equal(denied.statusCode,429);assert.ok(Number(denied.headers['Retry-After'])>0)
 db.runTransaction=async()=>{throw Error('offline')};assert.equal((await mod.authorizeApi(request,'news')).statusCode,503)
})
test('API cache shares in-flight work and never retains rejected upstream reads',async()=>{
 const {mod}=accessHarness();let calls=0
 const load=async()=>{calls++;return ['news']}
 assert.deepEqual(await Promise.all([mod.cachedApi('news',10000,load),mod.cachedApi('news',10000,load)]),[['news'],['news']]);assert.equal(calls,1)
 await assert.rejects(mod.cachedApi('failed',10000,async()=>{throw Error('offline')}))
 assert.equal(await mod.cachedApi('failed',10000,async()=>42),42)
})
test('foreign quote rejects oversized or invalid symbols, and auth denial makes zero upstream calls',async()=>{
 let calls=0
 const access=accessHarness().mod
 const mod=compile(read('netlify/lib/foreign-quote.js'),{...access,authorizeApi:async()=>access.apiError(401,'no'),fetch:async()=>{calls++;throw Error('unexpected')}})
 for(const queryStringParameters of [{symbols:Array.from({length:21},(_,i)=>'S'+i).join(',')},{symbols:'../../secret'},{symbols:'a',type:'invalid'}])assert.equal((await mod.handler({...request,queryStringParameters})).statusCode,400)
 assert.equal((await mod.handler({...request,queryStringParameters:{symbols:'AAPL'}})).statusCode,401);assert.equal(calls,0)
})
test('foreign quote bounds concurrency, deduplicates symbols, caches and serves requested charts',async()=>{
 let active=0,peak=0,calls=0,charged=0
 const access=accessHarness().mod
 const mod=compile(read('netlify/lib/foreign-quote.js'),{...access,authorizeApi:async(_,_route,units)=>{charged=units;return null},fetch:async()=>{
 calls++;active++;peak=Math.max(peak,active);await Promise.resolve();active--
 return {ok:true,json:async()=>({chart:{result:[{meta:{regularMarketPrice:10},timestamp:[1700000000],indicators:{quote:[{close:[10],volume:[5]}]}}]}})}
 }})
 const queryStringParameters={symbols:'A,B,C,D,E,F,A'}
 assert.equal((await mod.handler({...request,queryStringParameters})).statusCode,200);assert.equal(charged,6);assert.ok(peak<=4);assert.equal(calls,6)
 await mod.handler({...request,queryStringParameters});assert.equal(calls,6)
 const chart=await mod.handler({...request,queryStringParameters:{type:'chart',symbol:'A'}})
 assert.equal(JSON.parse(chart.body).bars[0].close,10)
})
test('authenticated client never sends token to external destinations or after account switch',async()=>{
 let changed=false,calls=0
 const token=deferred()
 const mod=compile(read('src/lib/authenticatedFetch.ts'),{investAuth:{currentUser:{getIdToken:()=>token.promise}},captureUserSession:()=>({assertActive:()=>{if(changed)throw Error('changed')}}),fetch:async()=>{calls++;return {ok:true}}})
 await assert.rejects(mod.authenticatedFetch('https://evil.test/'),/目的地/)
 const pending=mod.authenticatedFetch('/.netlify/functions/news-proxy');changed=true;token.resolve('secret');await assert.rejects(pending,/changed/);assert.equal(calls,0)
})
test('authenticated client exposes quota retry delay without automatic repeated requests',async()=>{
 let calls=0
 const mod=compile(read('src/lib/authenticatedFetch.ts'),{investAuth:{currentUser:{getIdToken:async()=> 'token'}},captureUserSession:()=>({assertActive:()=>{}}),fetch:async(_url,options)=>{calls++;assert.equal(options.headers.Authorization,'Bearer token');return {ok:false,status:429,headers:{get:()=> '60'},json:async()=>({error:'額度已達'})}}})
 await assert.rejects(mod.authenticatedFetch('/.netlify/functions/news-proxy'),/60 秒/);assert.equal(calls,1)
})
test('all deployed proxy entry modules load and reject anonymous callers without upstream requests',async()=>{
 for(const name of ['news-proxy','foreign-quote','market-cap-proxy','mops-proxy','yahoo-calendar-proxy']){
  const {default:handler}=await import('../netlify/functions/'+name+'.js')
  const result=await handler(new Request('https://example.test/.netlify/functions/'+name+'?symbols=AAPL'))
  assert.equal(result.status,401,name)
 }
})
