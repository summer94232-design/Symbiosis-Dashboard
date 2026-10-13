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

function fixtureSession(state = { user: 'a' }) {
 const uid = state.user
 const assertActive = () => { if (state.user !== uid) throw new Error('session changed') }
 return { uid, assertActive, col: (db,c) => { assertActive(); return db+'/'+uid+'/'+c }, doc: (db,c,id) => { assertActive(); return db+'/'+uid+'/'+c+'/'+id } }
}
test('F01 rich body, asset references and tag order survive JSON round trip and empty restore', async () => {
 const store = {
 'kms/a/notes': [{id:'n',data:()=>({title:'note',content:''})}],
 'kms/a/noteBodies': [{id:'n',data:()=>({contentDoc:{type:'doc',content:[{type:'image',attrs:{src:'url'}}]},assets:[{id:'image',storagePath:'path'}]})}],
 'kms/a/settings': [{id:'tagOrder',data:()=>({order:['b','a']})}]
 }
 const writes = new Map()
 const mod = compile(read('src/lib/backup.ts'), { investDB:'invest',kmsDB:'kms',captureUserSession:()=>fixtureSession(),getDocs:async path=>({docs:store[path]||[]}),writeBatch:()=>({set:(p,d)=>writes.set(p,d),commit:async()=>{}}),invalidateAllInvestData:()=>{} })
 const backup = mod.parseBackup(JSON.stringify(await mod.buildFullBackup()))
 assert.equal(backup.version,2)
 await mod.restoreFullBackup(backup)
 for(const [path,docs] of Object.entries(store)) for(const d of docs) assert.deepEqual(writes.get(path+'/'+d.id),d.data())
})
test('F13 switching accounts after batch 400 aborts without writing row 401 to B',async()=>{
 const state={user:'a'},writes=[]
 const mod=compile(read('src/lib/backup.ts'),{investDB:'invest',kmsDB:'kms',captureUserSession:()=>fixtureSession(state),writeBatch:()=>({set:(p)=>writes.push(p),commit:async()=>{state.user='b'}}),invalidateAllInvestData:()=>{}})
 await assert.rejects(mod.restoreFullBackup({invest:{watchlist:Array.from({length:401},(_,id)=>({id:String(id),data:{}}))},kms:{}}),/session changed/)
 assert.equal(writes.length,400);assert.ok(writes.every(p=>p.startsWith('invest/a/')))
})
for (const scenario of [
 {name:'past',date:'2000-01-01',type:'personal'},
 {name:'deselected',date:'2099-01-01',type:'tech'},
 {name:'outside window',date:'2099-01-01',type:'personal'},
 {name:'generated',kind:'generated',missing:true},
 {name:'legacy unknown',missing:true},
 {name:'true deletion',kind:'manual',missing:true,deleted:true},
]) test('F02 '+scenario.name,async()=>{
 const mod=compile(read('src/lib/googleCalendar.ts').replaceAll('import.meta.env.VITE_GOOGLE_CLIENT_ID',"'fixture'"),{investDB:'invest',captureUserSession:()=>({assertActive:()=>{},col:()=>'',doc:(_,c,id)=>({id})}),getDocsFromServer:async()=>({docs:scenario.missing?[]:[{id:'s',data:()=>({date:scenario.date,type:scenario.type})}]})},'export { reconcileATypeEvents };')
 const result=await mod.reconcileATypeEvents(['personal'],[{sourceId:'s',sourceKind:scenario.kind||'manual',sourceType:'personal',googleEventId:'g',cancelled:false}].map(e=>scenario.name==='legacy unknown'?{...e,sourceKind:undefined}:e))
 assert.deepEqual(result.deleteGoogleEventIds,scenario.deleted?['g']:[])
})
for (const fail of [false,true]) test('F06 saved body is retained; read failure preserves draft '+fail,async()=>{
 let local=JSON.stringify([{assetId:'asset',noteId:'n',storagePath:'users/a/notes/n/images/asset.webp',createdAt:'2000-01-01'}]);const deleted=[]
 const mod=compile(read('src/lib/kmsImages.ts'),{captureUserSession:()=>fixtureSession(),kmsAuth:{currentUser:{uid:'a'}},kmsDB:'kms',kmsStorage:'storage',localStorage:{getItem:()=>local,setItem:(_,v)=>{local=v}},userDoc:()=>'',getDocFromServer:async path=>{if(fail)throw Error('offline');return {exists:()=>true,data:()=>path.includes('noteBodies')?{assets:[{id:'asset'}]}:{}}},ref:(_,p)=>p,deleteObject:async p=>deleted.push(p),deleteDoc:async()=>{}})
 if(fail)await assert.rejects(mod.cleanupStaleNoteImageDrafts(),/offline/);else await mod.cleanupStaleNoteImageDrafts()
 assert.deepEqual(deleted,[]);assert.equal(JSON.parse(local).length,fail?1:0)
})
for(const scenario of [
 {name:'mapped owner',uid:'kms-a',claim:'invest-a',ok:true},
 {name:'same uid',uid:'invest-a',ok:true},
 {name:'cross user',uid:'b',claim:'invest-b'},
 {name:'legacy',uid:'kms-a',claim:'invest-a',path:'images/asset.webp'},
 {name:'different asset',uid:'kms-a',claim:'invest-a',path:'users/kms-a/notes/n/images/other.webp'},
 {name:'traversal',uid:'kms-a',claim:'invest-a',path:'users/kms-a/notes/n/images/../asset.webp'},
 {name:'thumbnail',uid:'kms-a',claim:'invest-a',thumbnailPath:'users/b/secret'},
])test('F14 '+scenario.name,async()=>{
 const mod=compile(read('firebase-functions/index.js'),{initializeApp:()=>{},getFirestore:()=>({}),getAuth:()=>({getUser:async uid=>({uid,customClaims:{investUid:scenario.claim}})}),defineBoolean:()=>({value:()=>false}),onDocumentWritten:()=>{},onSchedule:()=>{}},'export { validatedDraftPaths };')
 const result=await mod.validatedDraftPaths('invest-a','asset',{noteId:'n',assetId:'asset',storagePath:scenario.path||'users/'+scenario.uid+'/notes/n/images/asset.webp',thumbnailPath:scenario.thumbnailPath})
 assert.equal(result!==null,!!scenario.ok)
})

test('F01 summary-only old backup is rejected before investment writes',async()=>{
 let writes=0
 const mod=compile(read('src/lib/backup.ts'),{captureUserSession:()=>fixtureSession(),writeBatch:()=>{writes++;throw Error('unexpected')}})
 await assert.rejects(mod.restoreFullBackup({version:1,invest:{trades:[{id:'t',data:{}}]},kms:{notes:[{id:'n',data:{content:''}}]}}),/缺少正文/)
 assert.equal(writes,0)
})
test('F13 actual session references stay pinned and reject a replaced login object',()=>{
 const investAuth={currentUser:{uid:'a'}},kmsAuth={currentUser:{uid:'kms-a'}}
 const mod=compile(read('src/lib/userDB.ts'),{investAuth,kmsAuth,doc:(_, ...parts)=>parts.join('/'),collection:(_, ...parts)=>parts.join('/')})
 const session=mod.captureUserSession()
 assert.equal(session.doc('db','trades','t'),'users/a/trades/t')
 investAuth.currentUser={uid:'a'}
 assert.throws(()=>session.doc('db','trades','t'),/登入帳號已變更/)
})
for(const scenario of ['referenced','orphan','cross user','read failure'])test('F14 scheduled cleanup '+scenario,async()=>{
 const deleted=[],draftDeleted=[]
 const draft={ref:{path:'users/a/imageUploadDrafts/asset',delete:async()=>draftDeleted.push(true)},data:()=>({noteId:'n',assetId:'asset',storagePath:'users/kms-a/notes/n/images/asset.webp'})}
 const db={collectionGroup:()=>({where:()=>({limit:()=>({get:async()=>({docs:[draft]})})})}),doc:path=>({get:async()=>{if(scenario==='read failure')throw Error('offline');return {exists:true,data:()=>path.includes('noteBodies')&&scenario==='referenced'?{assets:[{id:'asset'}]}:{}}}})}
 const mod=compile(read('firebase-functions/index.js'),{initializeApp:()=>{},getFirestore:()=>db,getStorage:()=>({bucket:()=>({file:p=>({delete:async()=>deleted.push(p)})})}),getAuth:()=>({getUser:async uid=>({uid,customClaims:{investUid:scenario==='cross user'?'b':'a'}})}),defineBoolean:()=>({value:()=>true}),onDocumentWritten:()=>{},onSchedule:(_,fn)=>fn})
 if(scenario==='read failure')await assert.rejects(mod.cleanupKmsImageDrafts(),/offline/);else await mod.cleanupKmsImageDrafts()
 assert.equal(deleted.length,scenario==='orphan'?1:0)
 assert.equal(draftDeleted.length,['orphan','referenced'].includes(scenario)?1:0)
})
