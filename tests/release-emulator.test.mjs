import { updateSearchNote } from '../firebase-functions/search-index.js'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { initializeTestEnvironment, assertFails, assertSucceeds } from '@firebase/rules-unit-testing'
import { getDocs, getDocsFromServer, getDoc, getDocFromServer, collection, doc, writeBatch, runTransaction, query, where, orderBy, limit, startAfter } from 'firebase/firestore'
import { compile, read } from './helpers/compile.mjs'
import { createHash } from 'node:crypto'
import { reserveQuoteBudget } from '../netlify/lib/quote-budget.js'

const config = async (projectId, rulesFile) => initializeTestEnvironment({projectId,firestore:{host:'127.0.0.1',port:8085,rules:await readFile(rulesFile,'utf8')}})

test('A02 ledger emulator: two devices cannot sell the same inventory; old direct writers and stale revision batches are denied', async () => {
 const env = await config('demo-ledger-concurrency', 'firestore.invest.rules')
 try {
  const calc = compile(read('src/lib/calc.ts'))
  const validation = compile(read('src/lib/investmentValidation.ts'), calc)
  const integrity = compile(read('src/lib/ledgerIntegrity.ts'), calc)
  const trade = (overrides = {}) => {
   const row = {date:'2026-09-01',type:'buy',code:'2330',name:'fixture',price:100,shares:1000,fee:0,tax:0,...overrides}
   return {...row,total:calc.calcTradeTotal(row)}
  }
  await env.withSecurityRulesDisabled(async ctx => ctx.firestore().doc('users/a/trades/buy').set(trade()))
  const makeClient = () => {
   const db = env.authenticatedContext('a').firestore()
   const session = {assertActive(){},col:(_,name)=>collection(db,'users','a',name),doc:(_,name,id)=>doc(db,'users','a',name,id)}
   const mod = compile(read('src/lib/ledgerWrites.ts'), {...calc,...validation,...integrity,investDB:db,captureUserSession:()=>session,getDocFromServer,getDocsFromServer,runTransaction})
   return {db,session,...mod}
  }
  const a=makeClient(), b=makeClient(), sale=trade({date:'2026-09-02',type:'sell',shares:600})
  const results=await Promise.allSettled([a.commitLedgerWrites([{collection:'trades',id:'sell-a',data:sale,mode:'create'}]),b.commitLedgerWrites([{collection:'trades',id:'sell-b',data:sale,mode:'create'}])])
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1)
  assert.match(results.find(r=>r.status==='rejected').reason.message,/缺少 200 股/)
  const rows=(await getDocsFromServer(a.session.col(null,'trades'))).docs.map(d=>({...d.data(),id:d.id}))
  assert.equal(calc.calcPositions(rows).holdings['2330'].shares,400)
  await assertFails(a.db.doc('users/a/trades/old-client').set(sale))
  await assertFails(a.db.doc('users/a/dividends/old-client').set({date:'2026-09-02',code:'2330',cashDividend:0,stockDividend:1000}))
  await assertFails(a.db.doc('users/a/trades/buy').delete())
  const stale=writeBatch(a.db)
  stale.set(a.session.doc(null,'trades','stale-sale'),sale)
  stale.set(a.session.doc(null,'ledgerControl','revision'),{revision:1,updatedAt:'stale'})
  await assertFails(stale.commit())
  await assertFails(env.authenticatedContext('b').firestore().doc('users/a/ledgerControl/revision').get())
  const revision=(await getDocFromServer(a.session.doc(null,'ledgerControl','revision'))).data().revision
  assert.equal(revision,1)
  await assertSucceeds(a.db.doc('users/a/settings/unchanged').set({ok:true}))
  // Dividends use the same gate and remain valid when they do not invalidate inventory.
  await a.commitLedgerWrites([{collection:'dividends',id:'valid',data:{date:'2026-09-02',code:'2330',name:'fixture',cashDividend:100,stockDividend:0},mode:'create'}])
  assert.equal((await getDocFromServer(a.session.doc(null,'ledgerControl','revision'))).data().revision,2)
  await a.commitLedgerWrites([{collection:'trades',id:'margin-buy',data:trade({isMargin:true,marginRatio:0.6}),mode:'create'}])
  await assert.rejects(a.commitLedgerWrites([{collection:'trades',id:'cash-sale-with-margin-inventory',data:trade({date:'2026-09-03',type:'sell',shares:600}),mode:'create'}]),/缺少 200 股/)
  await a.commitLedgerWrites([{collection:'dividends',id:'received',data:{date:'2026-08-20',stockDistributionDate:'2026-09-03',status:'confirmed',code:'2454',name:'fixture',cashDividend:0,stockDividend:100},mode:'create'}])
  await a.commitLedgerWrites([{collection:'trades',id:'distribution-sale',data:trade({date:'2026-09-03',type:'sell',code:'2454',shares:100}),mode:'create'}])
  const receipt={date:'2026-10-05',code:'2330',name:'fixture',cashDividend:1900,stockDividend:0,status:'confirmed',cashPaymentDate:'2026-10-20'}
  const auto={collection:'dividends',id:'auto-div-TWSE-2330-2026-10-05',data:{...receipt,sourceAnnouncementId:'TWSE-2330-2026-10-05'},mode:'create'}
  const manual={collection:'dividends',id:'manual-same-event',data:receipt,mode:'create'}
  const confirmations=await Promise.allSettled([a.commitLedgerWrites([auto]),b.commitLedgerWrites([manual])])
  assert.equal(confirmations.filter(result=>result.status==='fulfilled').length,1)
  assert.match(confirmations.find(result=>result.status==='rejected').reason.message,/已有紀錄/)
  const dividends=(await getDocsFromServer(a.session.col(null,'dividends'))).docs.filter(row=>row.data().date==='2026-10-05')
  assert.equal(dividends.length,1)
 } finally { await env.cleanup() }
})

test('R06 emulator: a legacy margin distribution can be repaired without permitting a new oversell', async () => {
 const env = await config('demo-margin-dividend-repair', 'firestore.invest.rules')
 try {
  const calc = compile(read('src/lib/calc.ts'))
  const validation = compile(read('src/lib/investmentValidation.ts'), calc)
  const integrity = compile(read('src/lib/ledgerIntegrity.ts'), calc)
  const buy = {date:'2026-01-05',type:'buy',code:'2330',name:'fixture',price:100,shares:1000,fee:0,tax:0,total:40000,isMargin:true,marginAmount:60000}
  const sell = {...buy,date:'2026-03-03',type:'sell',shares:1100,total:50000,marginRepay:60000,marginPrincipal:60000,marginInterest:0}
  const otherBuy = {date:'2026-01-06',type:'buy',code:'2317',name:'fixture',price:100,shares:1000,fee:0,tax:0,total:100000}
  const otherSell = {...otherBuy,date:'2026-03-04',type:'sell',shares:100,total:10000}
  const dividend = {date:'2026-02-01',stockDistributionDate:'2026-03-02',code:'2330',name:'fixture',status:'confirmed',cashDividend:0,stockDividend:100}
  await env.withSecurityRulesDisabled(async ctx => {
   const batch = ctx.firestore().batch()
   for (const [id,data] of [['buy',buy],['sell',sell],['other-buy',otherBuy],['other-sell',otherSell]]) batch.set(ctx.firestore().doc('users/a/trades/'+id),data)
   batch.set(ctx.firestore().doc('users/a/dividends/div'),dividend)
   await batch.commit()
  })
  const db = env.authenticatedContext('a').firestore()
  const session = {assertActive(){},col:(_,name)=>collection(db,'users','a',name),doc:(_,name,id)=>doc(db,'users','a',name,id)}
  const writer = compile(read('src/lib/ledgerWrites.ts'), {...calc,...validation,...integrity,investDB:db,captureUserSession:()=>session,getDocFromServer,getDocsFromServer,runTransaction})
  await writer.commitLedgerWrites([{collection:'dividends',id:'div',mode:'update',data:{...dividend,stockDividendMarginShares:100}}])
  assert.equal((await getDocFromServer(session.doc(null,'dividends','div'))).data().stockDividendMarginShares,100)
  await assert.rejects(writer.commitLedgerWrites([{collection:'dividends',id:'div',mode:'update',data:{...dividend,stockDividendMarginShares:50}}]),/缺少 50 股/)
  assert.equal((await getDocFromServer(session.doc(null,'ledgerControl','revision'))).data().revision,1)
 } finally { await env.cleanup() }
})

test('quote budget emulator: concurrent cold instances and two devices share at most 55 leases',async()=>{
 const env=await config('demo-quote-budget','firestore.invest.rules')
 try {
  await env.withSecurityRulesDisabled(async context=>{
   const db=context.firestore(),now=Date.now()
   const leases=await Promise.all([reserveQuoteBudget(db,40,now),reserveQuoteBudget(db,40,now)])
   assert.equal(leases.reduce((total,row)=>total+row.granted,0),55)
   assert.equal((await reserveQuoteBudget(db,1,now+61000)).granted,0)
   assert.equal((await reserveQuoteBudget(db,55,now+70000)).granted,55)
  })
  await assertFails(env.authenticatedContext('a').firestore().doc('sharedData/fugleQuoteBudget').set({starts:[]}))
 }finally{await env.cleanup()}
})

test('A01/A07/A09 KMS emulator: atomic note/body/receipt and concurrent imports produce one copy per source row', async () => {
 const env = await config('demo-kms-import', 'firestore.kms.rules')
 try {
  const db=env.authenticatedContext('a').firestore()
  const session={assertActive(){},col:(_,name)=>collection(db,'users','a',name),doc:(_,name,id)=>doc(db,'users','a',name,id)}
  const mod=compile(read('src/lib/kmsImport.ts'), {...compile(read('src/lib/csv.ts')),...compile(read('src/lib/kmsSearch.ts')),kmsDB:db,captureUserSession:()=>session,runTransaction})
  const text='標題,內容,網址\n甲,"第一行\n第二行,含逗號",\n乙,純文字,'
  const results=await Promise.all([mod.importKmsNotes(text,'n.csv'),mod.importKmsNotes(text,'n.csv')])
  assert.equal(results.reduce((count,r)=>count+r.success,0),2)
  assert.ok(results.every(r=>!r.error))
  const notes=(await getDocsFromServer(session.col(null,'notes'))).docs
  assert.equal(notes.length,2);assert.ok(notes.every(row=>!Object.hasOwn(row.data(),'url')))
  assert.equal((await getDocsFromServer(session.col(null,'noteImports'))).docs.length,2)
  const bodies=(await getDocsFromServer(session.col(null,'noteBodies'))).docs
  assert.equal(bodies.find(row=>row.data().content.startsWith('第一')).data().content,'第一行\n第二行,含逗號')
  assert.equal((await mod.importKmsNotes(text,'n.csv')).duplicated,2)
  await assertFails(env.authenticatedContext('b').firestore().doc('users/a/noteImports/'+notes[0].id).get())
 } finally {await env.cleanup()}
})

test('shared fulltext emulator: all notes, incremental changes and owner-only read access',async()=>{
 const env=await config('demo-search-index','firestore.kms.rules')
 try {
  await env.withSecurityRulesDisabled(async context=>{
   const db=context.firestore();await db.doc('kmsSearch/a/state/manifest').set({schema:1,status:'ready',buckets:{},totalNotes:0,updatedAt:new Date().toISOString()})
   const batch=db.batch()
   for(let i=0;i<42;i++){batch.set(db.doc('users/a/notes/'+i),{title:'legacy without createdAt'});batch.set(db.doc('users/a/noteBodies/'+i),{content:i===41?'needle':'other'})}
   await batch.commit()
   for(let i=0;i<42;i++)await updateSearchNote(db,'a',String(i))
  })
  const db=env.authenticatedContext('a').firestore(),session={uid:'a',assertActive:()=>{}}
  const {cache}=compile(read('src/lib/cache.ts'))
  const reader=compile(read('src/lib/kmsFullTextIndex.ts'),{...compile(read('src/lib/kmsSearch.ts')),cache,kmsDB:db,captureUserSession:()=>session,doc,getDocFromServer})
  const result=await reader.searchKmsFullText('needle');assert.equal(result.scanned,42);assert.equal(result.rows[0].id,'41')
  await assertFails(db.doc('kmsSearch/a/state/manifest').update({totalNotes:0}))
  await assertFails(env.authenticatedContext('other').firestore().doc('kmsSearch/a/state/manifest').get())
  const manifest=(await db.doc('kmsSearch/a/state/manifest').get()).data(),page=Object.values(manifest.buckets).find(bucket=>bucket.pages.length).pages[0]
  await assertFails(env.authenticatedContext('other').firestore().doc('kmsSearch/a/fulltextShards/'+page).get())
  await assertFails(db.doc('kmsSearch/a/fulltextShards/'+page).set({data:'poison'}))
  await assertSucceeds(env.authenticatedContext('mapped',{investUid:'a'}).firestore().doc('kmsSearch/a/fulltextShards/'+page).get())
  await env.withSecurityRulesDisabled(async context=>{const db=context.firestore();await db.doc('users/a/notes/41').delete();await updateSearchNote(db,'a','41')})
  cache.invalidatePrefix('kms:fulltext:');assert.equal((await reader.searchKmsFullText('needle')).rows.length,0)
 }finally{await env.cleanup()}
})

test('Exact TWR emulator: concurrent report edits reject stale writes, identical retries succeed, other users are denied', async()=>{
 const env=await config('demo-exact-twr','firestore.invest.rules')
 try {
  const db=env.authenticatedContext('a').firestore()
  const session={assertActive:()=>{},doc:(_,name,id)=>doc(db,'users','a',name,id)}
  const {ledgerSignature}=compile(read('src/lib/exactTwr.ts'))
  const {saveExactTwrReport}=compile(read('src/lib/exactTwrStore.ts'),{investDB:db,captureUserSession:()=>session,runTransaction,ledgerSignature})
  const report={startDate:'2026-01-01',endDate:'2026-01-31',startValue:'100',endValue:'110',startSource:'statement',endSource:'statement',valuations:{},ledgerSignature:'fixture'}
  const saved=await saveExactTwrReport(report,'null')
  assert.deepEqual(await saveExactTwrReport(report,'null'),saved)
  const baseline=ledgerSignature(saved)
  const results=await Promise.allSettled([saveExactTwrReport({...report,endValue:'120'},baseline),saveExactTwrReport({...report,endValue:'130'},baseline)])
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1)
  assert.equal(results.filter(r=>r.status==='rejected').length,1)
  await assertFails(env.authenticatedContext('b').firestore().doc('users/a/settings/exactTwr').get())
 }finally{await env.cleanup()}
})

test('API emulator: shared quota transaction enforces concurrent limit and clients cannot read or reset counters',async()=>{
 const env=await config('demo-api-quota','firestore.invest.rules')
 try {
  await env.withSecurityRulesDisabled(async context=>{
   const db=context.firestore()
   const a=compile(read('netlify/lib/api-access.js'),{createHash}),b=compile(read('netlify/lib/api-access.js'),{createHash})
   const result=await Promise.all(Array.from({length:8},(_,i)=>(i%2?a:b).consumeQuota(db,'user','news',1,1000)))
   assert.equal(result.filter(n=>n===0).length,6);assert.equal(result.filter(n=>n>0).length,2)
   assert.equal((await db.doc('apiUsage/news_global').get()).data().dayUnits,6)
  })
  const client=env.authenticatedContext('user').firestore()
  await assertFails(client.doc('apiUsage/news_global').get())
  await assertFails(client.doc('apiUsage/news_global').set({dayUnits:0}))
 }finally{await env.cleanup()}
})

test('Batch emulator: tag rename updates notes and ordering in one real transaction',async()=>{
 const env=await config('demo-tag-transaction','firestore.kms.rules')
 try {
  const db=env.authenticatedContext('a').firestore()
  const session={uid:'a',assertActive:()=>{},col:(_,name)=>collection(db,'users','a',name),doc:(_,name,id)=>doc(db,'users','a',name,id)}
  const order={parentOrder:['old'],childOrder:{old:['old/child']}}
  await db.doc('users/a/settings/tagOrder').set(order)
  await db.doc('users/a/notes/n').set({title:'fixture',hashtags:['old/child','keep'],content:'preserve'})
  const search=compile(read('src/lib/kmsSearch.ts'))
  const mod=compile(read('src/lib/batchOperations.ts'),{...search,kmsDB:db,investDB:db,captureUserSession:()=>session,getDocs,runTransaction})
  await mod.renameKmsTag('old','new',order)
  const note=(await db.doc('users/a/notes/n').get()).data()
  assert.deepEqual(note.hashtags,['new/child','keep']);assert.equal(note.content,'preserve')
  assert.deepEqual((await db.doc('users/a/settings/tagOrder').get()).data().parentOrder,['new'])
  await assert.rejects(mod.renameKmsTag('new','next',order),/排序已變更/)
  assert.deepEqual((await db.doc('users/a/notes/n').get()).data().hashtags,['new/child','keep'])
 }finally{await env.cleanup()}
})

test('Batch emulator: stock and relations save together; meeting imports merge without duplicates',async()=>{
 const env=await config('demo-batch-invest','firestore.invest.rules')
 try {
  const db=env.authenticatedContext('a').firestore()
  const session={uid:'a',assertActive:()=>{},col:(_,name)=>collection(db,'users','a',name),doc:(_,name,id)=>doc(db,'users','a',name,id)}
  const bindings={investDB:db,kmsDB:db,captureUserSession:()=>session,getDocs,runTransaction}
  const mod=compile(read('src/lib/batchOperations.ts'),bindings)
  const entry={code:'2330',name:'fixture',themes:['theme']}
  await mod.saveIndustryEntry(entry,{up:['u'],down:['d']},null)
  assert.equal((await db.doc('users/a/industryRelations/u__2330').get()).exists,true)
  await mod.saveIndustryEntry(entry,{up:['u'],down:['d']},null)
  assert.equal((await db.collection('users/a/industryRelations').get()).size,2)
  const merge=compile(read('src/lib/investorMeetingMerge.ts'))
  const meetings=compile(read('src/lib/investorMeetings.ts'),{...bindings,validDates:merge.normalizeMeetingDates})
  const input={stockCode:'2330',stockName:'fixture',yearMonth:'2026-09',dates:['2026-09-09']}
  assert.equal(await meetings.addInvestorMeetingDates([input]),1)
  assert.equal(await meetings.addInvestorMeetingDates([input]),0)
  assert.deepEqual((await db.doc('users/a/investorMeetingOverrides/2330-2026-09').get()).data().addedDates,['2026-09-09'])
 }finally{await env.cleanup()}
})
test('Invest emulator: owner access, cross-account/anonymous denial, shared meetings read-only',async()=>{
 const env=await config('demo-invest-rules','firestore.invest.rules')
 try {
 const a=env.authenticatedContext('a').firestore(),b=env.authenticatedContext('b').firestore()
 await assertSucceeds(a.doc('users/a/cashflow/c').set({amount:100}))
 await assertFails(b.doc('users/a/cashflow/c').get());await assertFails(b.doc('users/a/cashflow/c').set({amount:200}))
 await assertFails(env.unauthenticatedContext().firestore().doc('users/a/cashflow/c').get())
 await env.withSecurityRulesDisabled(c=>c.firestore().doc('investorMeetings/m').set({title:'public'}))
 await assertSucceeds(a.doc('investorMeetings/m').get());await assertFails(a.doc('investorMeetings/m').set({title:'changed'}))
 }finally{await env.cleanup()}
})
test('Full backup emulator round trip restores split rich body, links, settings and ledger into empty account',async()=>{
 const env=await config('demo-backup-roundtrip','firestore.kms.rules')
 try {
 const db=env.authenticatedContext('fixture').firestore(),kmsDB=db,investDB=db
 let owner='source'
 const session=()=>({assertActive:()=>{},col:(_,name)=>collection(db,'users',owner,name),doc:(_,name,id)=>doc(db,'users',owner,name,id)})
 const calc=compile(read('src/lib/calc.ts'))
 const accounting={...calc,...compile(read('src/lib/investmentValidation.ts'),calc),...compile(read('src/lib/ledgerIntegrity.ts'),calc),getDocsFromServer}
 const module=compile(read('src/lib/backup.ts'),{...accounting,captureUserSession:session,kmsDB,investDB,getDocs,writeBatch,invalidateAllInvestData:()=>{}})
 const seed={
 'notes/n':{title:'fixture',content:'',links:['peer'],hashtags:['a']},'notes/peer':{title:'peer',content:'',links:['n']},
 'noteBodies/n':{content:'正文',contentDoc:{type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'正文'}]}]},assets:[{id:'image',storagePath:'fixture/image.webp'}]},
 'noteBodies/peer':{content:'peer'},'settings/tagOrder':{parentOrder:['a']},'trades/t':{date:'2026-01-01',type:'buy',code:'2330',shares:100,price:10,total:1000},
 'cashflow/c':{date:'2026-01-01',type:'in',amount:2000},
 'settings/exactTwr':{report:{startDate:'2026-01-01',endDate:'2026-01-31',startValue:'100',endValue:'110',startSource:'fixture',endSource:'fixture',valuations:{},ledgerSignature:'fixture'}},
 }
 // Disabled-rule setup is restricted to demo data; restoration itself uses owner authentication below.
 await env.withSecurityRulesDisabled(async c=>{const batch=c.firestore().batch();for(const [path,data]of Object.entries(seed))batch.set(c.firestore().doc('users/source/'+path),data);await batch.commit()})
 // Each fake account is independently authenticated, as in a real account migration.
 let activeDB=env.authenticatedContext('source').firestore()
 const boundSession=()=>{const captured=activeDB,uid=owner;return {assertActive:()=>{},col:(_,name)=>collection(captured,'users',uid,name),doc:(_,name,id)=>doc(captured,'users',uid,name,id)}}
 const commitLedgerRestore = (...args) => compile(read('src/lib/ledgerWrites.ts'), {...accounting,investDB:activeDB,captureUserSession:boundSession,getDocFromServer,runTransaction}).commitLedgerRestore(...args)
 const mod=compile(read('src/lib/backup.ts'),{...accounting,commitLedgerRestore,captureUserSession:boundSession,kmsDB:activeDB,investDB:activeDB,getDocs,writeBatch:()=>writeBatch(activeDB),invalidateAllInvestData:()=>{}})
 const backup=mod.parseBackup(JSON.stringify(await mod.buildFullBackup()))
 owner='target';activeDB=env.authenticatedContext('target').firestore()
 await mod.restoreFullBackup(backup)
 for(const [path,data]of Object.entries(seed))assert.deepEqual((await getDoc(doc(activeDB,'users/target/'+path))).data(),data)
 assert.equal(typeof module.buildFullBackup,'function')
 }finally{await env.cleanup()}
})
test('KMS emulator deletion claim prevents restore and retry completes cleanup',async()=>{
 const env=await config('demo-purge-recovery','firestore.kms.rules')
 try {
 const db=env.authenticatedContext('a').firestore(),session=()=>({assertActive:()=>{},doc:(_,col,id)=>doc(db,'users/a/'+col+'/'+id),col:(_,name)=>collection(db,'users/a/'+name)})
 await db.doc('users/a/trash/n').set({title:'fixture',links:[],assets:[{storagePath:'fixture/path'}]})
 await db.doc('users/a/noteBodies/n').set({content:'body'})
 let fail=true
 const purge=compile(read('src/lib/kmsPurge.ts'),{kmsDB:db,captureUserSession:session,runTransaction,deleteStoragePath:async()=>{if(fail)throw Error('injected storage failure')}})
 await assert.rejects(purge.purgeKmsTrash('n'),/injected/)
 assert.equal((await db.doc('users/a/trash/n').get()).data().purgeState,'deleting')
 assert.equal((await db.doc('users/a/noteBodies/n').get()).exists,true)
 const graph=compile(read('src/lib/kmsNoteLinks.ts'),{kmsDB:db,captureUserSession:session,runTransaction,getDocs,query,where})
 await assert.rejects(graph.mutateLinkedKmsNote({id:'n',mode:'restore'}),/無法復原/)
 fail=false;await purge.purgeKmsTrash('n')
 assert.equal((await db.doc('users/a/trash/n').get()).exists,false);assert.equal((await db.doc('users/a/noteBodies/n').get()).exists,false)
 }finally{await env.cleanup()}
})
