import test from 'node:test'
import assert from 'node:assert/strict'
import { compile, read } from './helpers/compile.mjs'
import { auditBackupHistory } from '../scripts/audit-backup-history.mjs'
const response = data => ({ok:true,json:async()=>data})
function googleHarness(){
 const state={uid:'a',switchAt:'',requests:[],store:new Map(),transactions:0}
 const session=()=>{const uid=state.uid,assertActive=()=>{if(state.uid!==uid)throw Error('session changed')};return {uid,assertActive,col:()=>{assertActive();return uid},doc:(_,col,id)=>{assertActive();return {id,path:uid+'/'+col+'/'+id}}}}
 const mod=compile(read('src/lib/googleCalendar.ts').replaceAll('import.meta.env.VITE_GOOGLE_CLIENT_ID',"'fixture'"),{
 investAuth:{get currentUser(){return {uid:typeof state==='object'?state.uid:undefined,getIdToken:async()=> 'fixture-id-token'}}},
 captureUserSession:session,investDB:'db',getDocsFromServer:async()=>({docs:[]}),updateDoc:async(ref,data)=>state.store.set(ref.path,{...state.store.get(ref.path),...data}),
 runTransaction:async(_,fn)=>{state.transactions++;return fn({get:async ref=>({exists:()=>state.store.has(ref.path)}),set:(ref,data)=>state.store.set(ref.path,data)})},
 fetch:async(url,init)=>{
 state.requests.push({url,...init})
 if(url.includes(state.switchAt)&&state.switchAt)state.uid='b'
 if(url.includes('ensure'))return response({calendarId:'calendar'})
 if(url.includes('pull'))return response({events:[{sourceId:null,googleEventId:'g',title:'native',date:'2026-09-08',description:'',updated:'now',cancelled:false}]})
 return response({links:[]})
 },
 })
 return {state,run:()=>mod.performGoogleCalendarSync({refreshToken:'fixture',calendarId:'calendar',syncTypes:['personal']})}
}
for(const stage of ['ensure','pull','sync'])test('Google account switch at '+stage+' stops subsequent work',async()=>{
 const h=googleHarness();h.state.switchAt=stage
 await assert.rejects(h.run(),/session changed/)
 assert.ok([...h.state.store.keys()].every(key=>key.startsWith('a/')))
 assert.equal(h.state.requests.at(-1).url.includes(stage),true)
 if(stage!=='sync')assert.equal(h.state.store.size,0)
})
test('Google retry after failed link-back uses same imported document, preserving newer local edits',async()=>{
 const h=googleHarness();await h.run();const [path]=h.state.store.keys();h.state.store.get(path).title='local edit'
 await h.run();assert.equal(h.state.store.size,1);assert.equal(h.state.store.get(path).title,'local edit')
 assert.equal(h.state.transactions,2)
})
function purgeHarness(){
 const state={uid:'a',failPath:'second',deleted:[]},store=new Map([
 ['trash/n',{deletedAt:'2000',assets:[{storagePath:'first'},{storagePath:'second'}]}],['noteBodies/n',{content:'body'}],
 ])
 const mod=compile(read('src/lib/kmsPurge.ts'),{
 kmsDB:'db',captureUserSession:()=>{const uid=state.uid;return {assertActive:()=>{if(uid!==state.uid)throw Error('switched')},doc:(_,col,id)=>col+'/'+id}},
 runTransaction:async(_,fn)=>{const writes=[];const result=await fn({get:async path=>({exists:()=>store.has(path),data:()=>store.get(path)}),update:(path,data)=>writes.push(()=>store.set(path,{...store.get(path),...data})),delete:path=>writes.push(()=>store.delete(path))});writes.forEach(f=>f());return result},
 deleteStoragePath:async path=>{if(path===state.failPath)throw Error('storage failed');state.deleted.push(path);if(state.switchAfterDelete)state.uid='b'},
 });return {store,state,run:()=>mod.purgeKmsTrash('n')}
}
test('Purge retains manifest and body on storage failure, then resumes to atomically remove documents',async()=>{
 const h=purgeHarness();await assert.rejects(h.run(),/storage failed/)
 assert.equal(h.store.get('trash/n').purgeState,'deleting');assert.equal(h.store.has('noteBodies/n'),true)
 h.state.failPath='';await h.run();assert.equal(h.store.size,0)
})
test('Purge cannot delete restored note and stops after account switch',async()=>{
 let h=purgeHarness();h.store.set('notes/n',{title:'restored'});await assert.rejects(h.run(),/已復原/);assert.deepEqual(h.state.deleted,[])
 h=purgeHarness();h.state.switchAfterDelete=true;await assert.rejects(h.run(),/switched/);assert.deepEqual(h.state.deleted,['first']);assert.equal(h.store.has('noteBodies/n'),true)
})
test('Mutation guard locks synchronously and releases after failure without clearing form',async()=>{
 const errors=[];const mod=compile(read('src/lib/useSafeMutation.ts'),{useRef:()=>({current:false}),useState:()=>['',v=>errors.push(v)],captureUserSession:()=>({assertActive:()=>{}})})
 const guard=mod.useSafeMutation();let release,calls=0;const pending=new Promise(r=>release=r)
 const first=guard.run(async()=>{calls++;await pending;throw Error('fixture failure')})
 await guard.run(async()=>{calls++});assert.equal(calls,1);release();await first
 await guard.run(async()=>{calls++});assert.equal(calls,2);assert.ok(errors.includes('fixture failure'))
})

test('Calendar sync UI rejects simultaneous starts and unlocks after failed auth lookup', async () => {
 let release, calls = 0
 const pending = new Promise(resolve => { release = resolve })
 const lock = { current: false }, errors = []
 const run = callback('src/pages/calendar/CalendarHome.tsx', 'handleSyncGoogleCalendar', {
  gcalSyncLock: lock, mutation: { busy: false }, setInvestorError: error => errors.push(error), setInvestorInfo: () => {},
  setGcalSyncing: () => {}, setGcalStage: () => {},
  captureUserSession: () => ({ assertActive: () => {} }),
  getGoogleCalendarAuth: async () => { calls++; await pending; throw Error('offline') },
  console: { error: () => {} },
 })
 const first = run()
 await run()
 assert.equal(calls, 1)
 release(); await first
 assert.equal(lock.current, false)
 await run()
 assert.equal(calls, 2)
 assert.ok(errors.some(error => error?.includes('offline')))
})
test('History audit flags breakdown mismatch without mutating stored NAV or verifying market prices',()=>{
 const backup={invest:{cashflow:[{id:'c',data:{date:'2026-01-01',type:'in',amount:100}}],assetSnapshots:[{id:'s',data:{date:'2026-09-08',cash:0,marginDebt:0,marketValue:50,totalAssets:100}}]}}
 const before=structuredClone(backup),report=auditBackupHistory(backup)
 assert.deepEqual(report.findings[0].issues,['cash-mismatch','nav-components-mismatch']);assert.equal(report.findings[0].expectedCash,100)
 assert.equal(report.findings[0].historicalMarketValueVerified,false);assert.deepEqual(backup,before)
})
import ts from 'typescript'
function callback(path,name,bindings){
 const source=read(path),ast=ts.createSourceFile('page.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX)
 let initializer
 const visit=n=>{if(ts.isVariableDeclaration(n)&&n.name.getText(ast)===name)initializer=n.initializer;ts.forEachChild(n,visit)};visit(ast)
 assert.ok(initializer,name)
 return compile('export const callback = '+initializer.getText(ast),bindings).callback
}

for (const page of ['HistoryPnL', 'IndustryChainView', 'IndustryMap', 'Watchlist']) {
 function loaderHarness(fail = false) {
  let request = 0, release
  const pending = new Promise(resolve => { release = resolve })
  const state = { rows: [], error: '', loading: true }
  const rows = id => [{ id: String(id), code: String(id), date: '2026-09-09', name: 'fixture', market: 'tw' }]
  const readRows = async id => { if (fail) throw Error('offline'); if (id === 1) await pending; return rows(id) }
  const setRows = rows => { state.rows = rows }
  const run = callback('src/pages/invest/' + page + '.tsx', 'load', {
   useCallback: fn => fn, loadRevision: { current: 0 }, investDB: 'fixture',
   captureUserSession: () => { const id = ++request; return { assertActive: () => {}, col: () => id } },
   getDocs: async id => ({ docs: (await readRows(id)).map(row => ({ id: row.id, data: () => row })) }),
   fetchTrades: () => readRows(request), fetchDividends: () => readRows(request),
   calcPositions: trades => ({ realized: trades }), receivedCashDividends: rows => rows, toLocalDateString: () => '2026-10-04', setDividends: () => {},
   setRecords: setRows, setLinks: setRows, setEntries: setRows, setItems: setRows, setStockDict: () => {},
   setLoadError: value => { state.error = value }, setLoading: value => { state.loading = value },
   UNGROUPED: 'none',
  })
  return { run, state, release }
 }
 test(page + ' ignores a slower previous read after a newer read succeeds', async () => {
  const h = loaderHarness()
  const old = h.run()
  await h.run()
  assert.equal(h.state.rows[0].id || h.state.rows[0].code, '2')
  h.release(); await old
  assert.equal(h.state.rows[0].id || h.state.rows[0].code, '2')
  assert.equal(h.state.loading, false)
 })
 test(page + ' read failure reports error and clears initial loading state', async () => {
  const h = loaderHarness(true)
  await h.run()
  assert.equal(h.state.error, 'offline')
  assert.equal(h.state.loading, false)
  assert.deepEqual(h.state.rows, [])
 })
}
for(const page of ['CashFlow','Dividend'])test(page+' retry after lost acknowledgement keeps one primary ID and atomic dictionary update',async()=>{
 const store=new Map(),state={fail:true,error:'',cleared:0},pendingId={current:null},form={date:'2026-09-08',code:'2330',name:'fixture',amount:100}
 const session={assertActive:()=>{},col:(_,col)=>col,doc:(_,col,id)=>col+'/'+id}
 const run=callback('src/pages/invest/'+page+'.tsx','handleSave',{
 form,editingId:null,pendingId,investDB:'db',empty:{},doc:()=>({id:'fixed'}),
 validateCashflowForWrite:()=>({valid:true}),validateDividendForWrite:()=>({valid:true}),feedback:{clear(){},report(){}},setFormError:()=>{},
 mutation:{run:async fn=>{try{await fn(session)}catch(e){state.error=e.message}}},
 commitLedgerWrites:async(writes,session,names)=>{writes.forEach(w=>store.set(session.doc('db',w.collection,w.id),w.data));for(const[code,name]of Object.entries(names||{}))store.set(session.doc('db','stockDict',code),{name});if(state.fail)throw Error('lost acknowledgement')},
 writeBatch:()=>{const writes=[];return {set:(p,d)=>writes.push([p,d]),update:(p,d)=>writes.push([p,d]),commit:async()=>{writes.forEach(([p,d])=>store.set(p,d));if(state.fail)throw Error('lost acknowledgement')}}},
 invalidateCashflow:()=>{},invalidateDividends:()=>{},cacheStockName:()=>{},setEditingId:()=>{},setForm:()=>state.cleared++,load:async()=>{},
 })
 await run();assert.equal(state.cleared,0);assert.equal(pendingId.current,'fixed')
 state.fail=false;await run();assert.equal(state.cleared,1);assert.equal(pendingId.current,null)
 assert.equal(store.size,page==='Dividend'?2:1)
 if(page==='Dividend')assert.ok(store.has('stockDict/2330'))
})
test('Remote draft deletion failure preserves local retry record',async()=>{
 let local=JSON.stringify([{assetId:'x',noteId:'n',createdAt:'2000'}])
 const mod=compile(read('src/lib/kmsImages.ts'),{captureUserSession:()=>({assertActive:()=>{},doc:()=>''}),kmsAuth:{currentUser:{uid:'a'}},kmsDB:'db',localStorage:{getItem:()=>local,setItem:(_,value)=>local=value},deleteDoc:async()=>{throw Error('offline')}},'export { removeUploadDrafts }')
 await assert.rejects(mod.removeUploadDrafts(['x']),/offline/);assert.equal(JSON.parse(local).length,1)
})
for(const [name,draftName]of [['handleSaveTask','taskDraftId'],['handleSaveProject','projectDraftId']])test('Task manager '+name+' retries same ID and retains input on failure',async()=>{
 const records=new Map(),draft={current:null},state={fail:true,cleared:0}
 const fn=callback('src/pages/calendar/TaskManager.tsx',name,{
 taskForm:{title:'task',priority:'medium'},projectForm:{title:'project',color:'red'},editingTask:null,tasks:[],projects:[],[draftName]:draft,
 investDB:'db',PROJECT_COLORS:['red'],doc:()=>({id:'one'}),
 mutation:{run:async work=>{try{await work({assertActive:()=>{},col:(_,c)=>c,doc:(_,c,id)=>c+'/'+id})}catch{/* displayed by shared guard */}}},
 setDoc:async(path,data)=>{records.set(path,data);if(state.fail)throw Error('lost ack')},
 setTaskForm:()=>state.cleared++,setProjectForm:()=>state.cleared++,invalidateTasks:()=>{},invalidateTaskProjects:()=>{},setShowTaskForm:()=>{},setShowProjectForm:()=>{},setEditingTask:()=>{},loadTasks:()=>{},loadProjects:()=>{},
 })
 await fn();assert.equal(state.cleared,0);assert.equal(draft.current,'one')
 state.fail=false;await fn();assert.equal(state.cleared,1);assert.equal(records.size,1)
})
