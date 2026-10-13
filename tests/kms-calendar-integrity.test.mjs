import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
const read = p => readFileSync(p, 'utf8')
function compile(source, bindings = {}, extra = '') {
  const ast = ts.createSourceFile('audit.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  for (const node of [...ast.statements].reverse()) {
    if (ts.isImportDeclaration(node)) source = source.slice(0, node.pos) + source.slice(node.end)
  }
  const output = ts.transpileModule(source + '\n' + extra, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText
  const exports = {}
  new Function('exports', ...Object.keys(bindings), output)(exports, ...Object.values(bindings))
  return exports
}

const search=compile(read('src/lib/kmsSearch.ts'))
for(const [label,note,term,expected] of [
 ['long title tail',{title:'長'.repeat(400)+'尾端詞'},'尾端詞',true],
 ['tag after long title',{title:'長'.repeat(400),hashtags:['投資/台積電']},'台積電',true],
 ['URL',{title:'書籤',url:'https://example.com/unique-path'},'unique-path',true],
 ['normalization',{title:'ＡＢＣ　中文'},'a b c中文',true],
 ['body deliberately excluded',{title:'標題',content:'正文密詞'},'正文密詞',false],
])test('F20 '+label,()=>assert.equal(search.matchesKmsSummary(note,term),expected))
const home=read('src/pages/kms/KMSHome.tsx')
const bodySource=home.slice(home.indexOf('function noteBody('),home.indexOf('function noteSummary('))
const {noteBody}=compile(bodySource,{},'export { noteBody }')
const {initializeApp,deleteApp}=await import('firebase/app')
const {getFirestore,writeBatch,doc}=await import('firebase/firestore')
test('F10 title-only, URL-only and legacy text bodies pass real Firestore serialization without network',async()=>{
 const app=initializeApp({projectId:'demo-f10'},'f10-integrity')
 try {
 for(const note of [{title:'標題'},{title:'網址',url:'https://example.com'},{title:'改標題',content:'原有正文'},{contentDoc:{type:'doc',content:[{type:'paragraph'}]}}]){
 const body=noteBody(note)
 assert.doesNotThrow(()=>writeBatch(getFirestore(app)).set(doc(getFirestore(app),'notes','fixture'),body))
 assert.equal(Object.hasOwn(body,'contentDoc'),note.contentDoc!==undefined)
 assert.equal(body.content,note.content||'')
 }
 }finally{await deleteApp(app)}
})
function noteHarness(seed){
 const store=new Map(Object.entries(seed)),state={uid:'a',fail:false,beforeTransaction:null}
 const snap=path=>{const value=structuredClone(store.get(path));return {id:path.split('/').at(-1),ref:path,exists:()=>value!==undefined,data:()=>value}}
 const mod=compile(read('src/lib/kmsNoteLinks.ts'),{
 kmsDB:'db',captureUserSession:()=>{const uid=state.uid,assertActive=()=>{if(uid!==state.uid)throw Error('session changed')};return {assertActive,doc:(_,col,id)=>{assertActive();return col+'/'+id},col:(_,col)=>col}},
 where:(_,op,id)=>id,query:(col,id)=>({col,id}),getDocs:async({col,id})=>({docs:[...store.keys()].filter(p=>p.startsWith(col+'/')&&store.get(p).links?.includes(id)).map(snap)}),
 runTransaction:async(_,fn)=>{
 if(state.beforeTransaction)state.beforeTransaction()
 const writes=[];let writing=false
 const result=await fn({get:async p=>{assert.equal(writing,false,'all reads before writes');return snap(p)},
 set:(p,d)=>{writing=true;writes.push(()=>store.set(p,structuredClone(d)))},
 update:(p,d)=>{writing=true;writes.push(()=>store.set(p,{...store.get(p),...structuredClone(d)}))},
 delete:p=>{writing=true;writes.push(()=>store.delete(p))}})
 if(state.fail)throw Error('commit failed')
 writes.forEach(write=>write());return result
 }
 });return {store,state,run:mod.mutateLinkedKmsNote}
}
const note=(links=[],extra={})=>({title:'fixture',links,updatedAt:'v1',hashtags:['跨標籤'],...extra})
test('F15 save adds reverse link using unseen database peer, and keeps its other links',async()=>{
 const {run,store}=noteHarness({'notes/a':note(),'notes/b':note(['c']),'notes/c':note(['b'])})
 await run({id:'a',mode:'save',summary:note(['b']),body:{content:'正文'},expectedUpdatedAt:'v1'})
 assert.deepEqual(store.get('notes/b').links,['c','a']);assert.equal(store.get('noteBodies/a').content,'正文')
})
test('F15 delete and restore repair outgoing and legacy incoming links outside visible filter',async()=>{
 const {run,store}=noteHarness({'notes/a':note(['b']),'notes/b':note(['a','d']),'notes/c':note(['a']),'notes/d':note(['b']),'noteBodies/a':{content:'保留'}})
 await run({id:'a',mode:'delete'});assert.equal(store.has('notes/a'),false)
 assert.deepEqual(store.get('notes/b').links,['d']);assert.deepEqual(store.get('notes/c').links,[])
 await run({id:'a',mode:'restore'})
 assert.deepEqual(new Set(store.get('notes/a').links),new Set(['b','c']))
 assert.deepEqual(store.get('notes/b').links,['d','a']);assert.deepEqual(store.get('notes/c').links,['a'])
 assert.equal(store.get('noteBodies/a').content,'保留');assert.equal(store.has('trash/a'),false)
})
test('F15 two deleted peers restore without dangling links and reconnect on second restore',async()=>{
 const {run,store}=noteHarness({'notes/a':note(['b']),'notes/b':note(['a'])})
 await run({id:'a',mode:'delete'});await run({id:'b',mode:'delete'})
 await run({id:'b',mode:'restore'});assert.deepEqual(store.get('notes/b').links,[])
 await run({id:'a',mode:'restore'});assert.deepEqual(store.get('notes/a').links,['b']);assert.deepEqual(store.get('notes/b').links,['a'])
})
test('F15 stale editor cannot erase newer links; missing target and duplicate restore reject atomically',async()=>{
 const {run,store}=noteHarness({'notes/a':note(['b'],{updatedAt:'v2'}),'notes/b':note(['a'])})
 const before=structuredClone(store)
 await assert.rejects(run({id:'a',mode:'save',summary:note([]),expectedUpdatedAt:'v1'}),/其他操作/)
 await assert.rejects(run({id:'a',mode:'save',summary:note(['missing']),expectedUpdatedAt:'v2'}),/不存在/)
 await assert.rejects(run({id:'a',mode:'restore'}),/已復原/)
 assert.deepEqual(store,before)
})
test('F15 commit failure and account change leave graph unchanged',async()=>{
 const {run,store,state}=noteHarness({'notes/a':note(['b']),'notes/b':note(['a'])}),before=structuredClone(store)
 state.fail=true;await assert.rejects(run({id:'a',mode:'delete'}),/commit failed/);assert.deepEqual(store,before)
 state.fail=false;state.beforeTransaction=()=>{state.uid='b'}
 await assert.rejects(run({id:'a',mode:'delete'}),/session changed/);assert.deepEqual(store,before)
})
function metadataHarness(){
 const store=new Map(),writes=[]
 const snapshot=path=>({id:path.split('/').at(-1),ref:path,exists:store.has(path),data:()=>structuredClone(store.get(path))})
 const db={doc:p=>p,collection:p=>({collection:p}),runTransaction:async fn=>{
 const pending=[];let writing=false
 await fn({get:async p=>{assert.equal(writing,false);return p.collection?{docs:[...store.keys()].filter(k=>k.startsWith(p.collection+'/')).sort().map(snapshot)}:snapshot(p)},
 update:(p,d)=>{writing=true;pending.push(()=>store.set(p,{...store.get(p),...d}));writes.push(p)},
 set:(p,d)=>{writing=true;pending.push(()=>store.set(p,d));writes.push(p)}});pending.forEach(f=>f())
 }}
 const mod=compile(read('firebase-functions/index.js'),{initializeApp:()=>{},getFirestore:()=>db,defineBoolean:()=>({value:()=>false}),onDocumentWritten:(_,fn)=>fn,onSchedule:()=>{}})
 return {store,writes,run:mod.maintainKmsNoteMetadata}
}
test('F08 duplicate and out-of-order events use current documents, including immediate delete',async()=>{
 const {store,run,writes}=metadataHarness(),event={id:'same',params:{userId:'u',noteId:'n'}}
 store.set('users/u/notes/n',{title:'note',hashtags:['a/x','a/x','a/y']})
 await run(event);const count=writes.length;await run(event);assert.equal(writes.length,count)
 assert.deepEqual(store.get('users/u/metadata/tagStats').counts,{'a/x':1,'a/y':1})
 store.set('users/u/notes/n',{title:'new',hashtags:['b']});await run({...event,id:'older'})
 assert.deepEqual(store.get('users/u/metadata/tagStats').counts,{b:1})
 store.delete('users/u/notes/n');await run(event);await run({...event,id:'older-create'})
 assert.equal(store.get('users/u/metadata/tagStats').totalNotes,0)
 assert.deepEqual(store.get('users/u/metadata/tagStats').counts,{})
})
test('F08 rebuilds previously wrong aggregate without counting metadata-only updates twice',async()=>{
 const {store,run}=metadataHarness()
 store.set('users/u/metadata/tagStats',{totalNotes:500,counts:{wrong:500},rootCounts:{wrong:500},untagged:500})
 store.set('users/u/notes/n',{title:'x',hashtags:[]})
 await run({params:{userId:'u',noteId:'n'}});await run({params:{userId:'u',noteId:'n'}})
 assert.equal(store.get('users/u/metadata/tagStats').totalNotes,1);assert.equal(store.get('users/u/metadata/tagStats').untagged,1)
})
test('F15 two deleted peers reconnect when restored in original deletion order',async()=>{
 const {run,store}=noteHarness({'notes/a':note(['b']),'notes/b':note(['a'])})
 await run({id:'a',mode:'delete'});await run({id:'b',mode:'delete'})
 await run({id:'a',mode:'restore'});assert.deepEqual(store.get('notes/a').links,[])
 await run({id:'b',mode:'restore'});assert.deepEqual(store.get('notes/a').links,['b']);assert.deepEqual(store.get('notes/b').links,['a'])
})
const apiResponse=(data,status=200)=>({ok:status>=200&&status<300,status,json:async()=>data})
const allDay={id:'g',etag:'"v1"',summary:'全天',start:{date:'2026-09-08'},end:{date:'2026-09-09'}}
const timed={...allDay,start:{dateTime:'2026-09-08T14:00:00+08:00',timeZone:'Asia/Taipei'},end:{dateTime:'2026-09-08T15:00:00+08:00',timeZone:'Asia/Taipei'}}
function syncHarness(current=allDay,patchStatus=200){
 const calls=[]
 const mod=compile(read('netlify/functions/google-calendar-sync.js'),{authorizeGoogleRequest:async()=>null,process:{env:{}},fetch:async(url,options={})=>{
 calls.push({url,...options})
 if(url.includes('oauth2'))return apiResponse({access_token:'fixture'})
 if(!options.method)return apiResponse(current)
 return apiResponse({id:'g'},patchStatus)
 }})
 const run=async(events,deleteGoogleEventIds=[])=>JSON.parse((await mod.handleEvent({httpMethod:'POST',body:JSON.stringify({refreshToken:'fixture',calendarId:'fixture',events,deleteGoogleEventIds})})).body)
 return {calls,run}
}
test('F18 link-only PATCH touches no time, title, description or recurrence fields',async()=>{
 const {run,calls}=syncHarness(timed)
 assert.equal((await run([{id:'n',googleEventId:'g',linkOnly:true}])).updated,1)
 const patch=JSON.parse(calls.find(c=>c.method==='PATCH').body)
 assert.deepEqual(Object.keys(patch),['extendedProperties'])
 assert.equal(patch.extendedProperties.private.sourceId,'n')
})
for(const [name,item] of [['timed',timed],['multi-day',{...allDay,end:{date:'2026-09-11'}}],['recurring',{...allDay,recurringEventId:'series'}]])test('F18 backend preserves schedule while updating or deleting '+name,async()=>{
 const {run,calls}=syncHarness(item)
 const result=await run([{id:'n',googleEventId:'g',date:'2026-09-08',title:'x'}],['g'])
 assert.equal(result.updated,1);assert.equal(result.deleted,1);assert.equal(result.warnings.length,0)
 const patch=JSON.parse(calls.find(c=>c.method==='PATCH').body)
 assert.deepEqual(patch.start,item.start);assert.deepEqual(patch.end,item.end)
 assert.equal(Object.hasOwn(patch,'recurrence'),false)
 assert.equal(calls.find(c=>c.method==='DELETE').headers['If-Match'],item.etag)
})
test('F18 supported update uses version condition; stale version is a failure',async()=>{
 for(const status of [200,412]){
 const {run,calls}=syncHarness(allDay,status)
 const result=await run([{id:'n',googleEventId:'g',date:'2026-09-08',title:'x'}])
 assert.equal(result.updated,status===200?1:0);assert.equal(result.failed,status===412?1:0)
 assert.equal(calls.find(c=>c.method==='PATCH').headers['If-Match'],'"v1"')
 }
})
test('F18 pull retains full time boundaries and accepts timed/multi-day/recurring events',async()=>{
 const items=[allDay,timed,{...allDay,id:'multi',end:{date:'2026-09-11'}},{...allDay,id:'repeat',recurringEventId:'series'},{id:'cancel',status:'cancelled',recurringEventId:'series'}]
 const mod=compile(read('netlify/functions/google-calendar-pull.js'),{authorizeGoogleRequest:async()=>null,process:{env:{}},fetch:async url=>apiResponse(url.includes('oauth2')?{access_token:'fixture'}:{items})})
 const result=JSON.parse((await mod.handleEvent({httpMethod:'POST',body:JSON.stringify({refreshToken:'fixture',calendarId:'fixture'})})).body)
 assert.equal(result.events.length,5);assert.equal(result.events.some(e=>e.unsupported),false);assert.equal(result.events[3].recurringEventId,'series');assert.equal(result.events[4].cancelled,true)
 assert.deepEqual(result.events[1].start,timed.start);assert.deepEqual(result.events[1].end,timed.end);assert.equal(result.events[1].date,'2026-09-08')
})
test('F18 timed linked, recurring native and multi-day deleted events reconcile normally',async()=>{
 const date=new Date().toISOString().slice(0,10)
 const mod=compile(read('src/lib/googleCalendar.ts').replaceAll('import.meta.env.VITE_GOOGLE_CLIENT_ID',"'fixture'"),{
 investAuth:{get currentUser(){return {uid:typeof state==='object'?state.uid:undefined,getIdToken:async()=> 'fixture-id-token'}}},
 investDB:'db',captureUserSession:()=>({assertActive:()=>{},col:()=>'',doc:(_,c,id)=>({id})}),getDocsFromServer:async()=>({docs:[{id:'n',data:()=>({date,title:'x',type:'personal',googleEventId:'g',updatedAt:'9999'})}]})
 },'export { reconcileATypeEvents }')
 const result=await mod.reconcileATypeEvents(['personal'],[
 {sourceId:'n',googleEventId:'g',...timed,updated:'2000',title:'時段',cancelled:false},
 {sourceId:null,googleEventId:'native',...timed,date,recurringEventId:'series',updated:'2000',title:'重複',cancelled:false},
 {sourceId:'deleted',sourceKind:'manual',sourceType:'personal',googleEventId:'gone',...allDay,title:'跨日',cancelled:false},
 ])
 assert.equal(result.firestoreCreates.length,1);assert.equal(result.firestoreCreates[0].recurringEventId,'series');assert.deepEqual(result.firestoreCreates[0].start,timed.start)
 assert.equal(result.pushList.length,1);assert.deepEqual(result.deleteGoogleEventIds,['gone']);assert.equal(result.warnings.length,0)
})
test('F15 graph revision rejects concurrent relation edit even with identical millisecond timestamp',async()=>{
 const {run,store}=noteHarness({'notes/a':note(['b'],{graphRevision:2}),'notes/b':note(['a'])}),before=structuredClone(store)
 await assert.rejects(run({id:'a',mode:'save',summary:note([]),expectedUpdatedAt:'v1',expectedGraphRevision:1}),/其他操作/)
 assert.deepEqual(store,before)
})
test('F18 full frontend sync sends native all-day and timed linking as metadata-only',async()=>{
 const sent=[],created=[]
 const mod=compile(read('src/lib/googleCalendar.ts').replaceAll('import.meta.env.VITE_GOOGLE_CLIENT_ID',"'fixture'"),{
 investAuth:{get currentUser(){return {uid:typeof state==='object'?state.uid:undefined,getIdToken:async()=> 'fixture-id-token'}}},
 investDB:'db',captureUserSession:()=>({assertActive:()=>{},col:()=>'',doc:(_,c,id)=>({id})}),userDoc:()=>'',getDocsFromServer:async()=>({docs:[]}),
 runTransaction:async(_,fn)=>fn({get:async()=>({exists:()=>false}),set:(_,data)=>created.push(data)}),updateDoc:async()=>{},
 fetch:async(url,options)=>{
 if(url.includes('ensure'))return apiResponse({calendarId:'fixture'})
 if(url.includes('pull'))return apiResponse({events:[{sourceId:null,googleEventId:'g',date:'2026-09-08',title:'native',description:'original',updated:'now',cancelled:false},{sourceId:null,googleEventId:'timed',title:'時段',date:'2026-09-08',description:'',updated:'now',...timed}]})
 const payload=JSON.parse(options.body);sent.push(...payload.events);return apiResponse({updated:1,links:[{id:'local',googleEventId:'g'}]})
 }
 })
 const result=await mod.performGoogleCalendarSync({calendarId:'fixture',refreshToken:'fixture',syncTypes:['personal']})
 assert.equal(created.length,2);assert.equal(sent.length,2);assert.equal(sent.every(e=>e.linkOnly),true);assert.equal(sent[0].googleEventId,'g');assert.deepEqual(created[1].start,timed.start);assert.equal(result.warnings.length,0)
})
