import test from 'node:test'
import assert from 'node:assert/strict'
import { compile, read } from './helpers/compile.mjs'
const search=compile(read('src/lib/kmsSearch.ts'))
const timing=compile(read('src/lib/calendarTiming.ts'))
const session={uid:'a',assertActive:()=>{},col:(_,c)=>c,doc:(_,c,id)=>c+'/'+id}
test('calendar all-day inclusive editor end maps to exclusive API end',()=>{
 const schedule=timing.timingForWrite('2026-09-09',{...timing.emptyTimingDraft(),endDate:'2026-09-11'})
 assert.equal(schedule.end.date,'2026-09-12')
 const event={date:'2026-09-09',...schedule}
 assert.equal(timing.eventOccursOn(event,'2026-09-11'),true);assert.equal(timing.eventOccursOn(event,'2026-09-12'),false)
 assert.equal(timing.timingDraft(event).endDate,'2026-09-11')
})
test('calendar timed midnight exclusive boundary and foreign timezone use Taipei dates',()=>{
 const event={date:'2026-09-09',start:{dateTime:'2026-09-09T23:00:00+08:00'},end:{dateTime:'2026-09-11T00:00:00+08:00'},recurringEventId:'series'}
 assert.equal(timing.eventOccursOn(event,'2026-09-10'),true);assert.equal(timing.eventOccursOn(event,'2026-09-11'),false)
 assert.equal(timing.calendarDate({dateTime:'2026-09-08T20:00:00-07:00'}),'2026-09-09')
 assert.match(timing.eventScheduleLabel(event),/重複行程（本次）/)
 assert.deepEqual(timing.timingForWrite(event.date,timing.timingDraft(event),event),{start:event.start,end:event.end})
})
test('calendar rejects invalid dates and nonpositive duration; accepts overnight',()=>{
 assert.throws(()=>timing.timingForWrite('2026-02-30',timing.emptyTimingDraft()),/有效/)
 assert.throws(()=>timing.timingForWrite('2026-09-09',{allDay:false,startTime:'10:00',endTime:'09:00',endDate:''}),/晚於/)
 assert.equal(timing.timingForWrite('2026-09-09',{allDay:false,startTime:'23:00',endTime:'01:00',endDate:'2026-09-10'}).end.dateTime,'2026-09-10T01:00:00+08:00')
})
function transactionHarness(seed={}) {
 const store=new Map(Object.entries(structuredClone(seed))),state={failAt:0,transactions:0,changeSession:false,before:null,lostAck:false}
 const snapshot=p=>({id:p.split('/').at(-1),exists:()=>store.has(p),data:()=>structuredClone(store.get(p))})
 const bindings={...search,query:(ref)=>ref,orderBy:()=>null,limit:()=>null,startAfter:()=>null,kmsDB:'kms',investDB:'invest',captureUserSession:()=>({...session,assertActive:()=>{if(state.changeSession)throw Error('session changed')}}),getDocs:async c=>({docs:[...store.keys()].filter(k=>k.startsWith(c+'/')).map(snapshot)}),runTransaction:async(_,fn)=>{
 state.transactions++;if(state.before){const before=state.before;state.before=null;before(store)}
 const writes=[];let writing=false
 const result=await fn({get:async p=>{assert.equal(writing,false,'transaction reads must precede writes');return snapshot(p)},set:(p,d,opts)=>{writing=true;writes.push(()=>store.set(p,opts?.merge?{...store.get(p),...structuredClone(d)}:structuredClone(d)))},update:(p,d)=>{writing=true;writes.push(()=>store.set(p,{...store.get(p),...structuredClone(d)}))},delete:p=>{writing=true;writes.push(()=>store.delete(p))}})
 if(state.failAt===state.transactions)throw Error('commit failed')
 writes.forEach(fn=>fn());if(state.lostAck){state.lostAck=false;throw Error('lost acknowledgement')}return result
 }}
 return {store,state,bindings,mod:compile(read('src/lib/batchOperations.ts'),bindings)}
}
const order={parentOrder:['old','keep'],childOrder:{old:['old/a']}}
test('tag rename atomically updates latest tags, indexes and ordering without overwriting prose',async()=>{
 const {mod,store,state}=transactionHarness({'settings/tagOrder':order,'notes/n':{title:'title',hashtags:['old/a'],content:'body'}})
 state.before=store=>store.get('notes/n').hashtags.push('concurrent')
 assert.equal((await mod.renameKmsTag('old','new',order)).count,1)
 assert.deepEqual(store.get('notes/n').hashtags,['new/a','concurrent']);assert.equal(store.get('notes/n').content,'body')
 assert.deepEqual(store.get('settings/tagOrder').parentOrder,['new','keep'])
 assert.ok(store.get('notes/n').tagPaths.includes('new'))
})
test('tag rename failed commit, changed order, or changed account leave every document intact',async()=>{
 for(const mode of ['commit','order','session']) {
 const {mod,store,state}=transactionHarness({'settings/tagOrder':order,'notes/n':{hashtags:['old/a']}})
 if(mode==='commit')state.failAt=1
 if(mode==='order')store.set('settings/tagOrder',{parentOrder:['other'],childOrder:{}})
 if(mode==='session')state.changeSession=true
 const before=structuredClone(store)
 await assert.rejects(mod.renameKmsTag('old','new',order));assert.deepEqual(store,before)
 }
})
test('tag rename stops over-limit before writes and rejects recursive destination',async()=>{
 const {mod,store,state}=transactionHarness(Object.fromEntries(Array.from({length:450},(_,i)=>['notes/'+i,{hashtags:['old']}]))),before=structuredClone(store)
 await assert.rejects(mod.renameKmsTag('old','new',order),/449/);assert.equal(state.transactions,0);assert.deepEqual(store,before)
 await assert.rejects(mod.renameKmsTag('old','old/child',order),/子層/)
})
const stock={code:'2330',name:'台積電',themes:['晶圓'],note:''}
test('industry entry and relationships commit together; failed save does not leave partial stock',async()=>{
 const {mod,store,state}=transactionHarness();state.failAt=1
 await assert.rejects(mod.saveIndustryEntry(stock,{up:['one'],down:['two']},null),/commit/);assert.equal(store.size,0)
 state.failAt=0;await mod.saveIndustryEntry(stock,{up:['one'],down:['two']},null)
 assert.equal(store.size,3);assert.deepEqual(store.get('industryRelations/one__2330'),{from:'one',to:'2330'})
})
test('industry lost acknowledgement is retryable and stale edit cannot overwrite latest stock',async()=>{
 const {mod,store,state}=transactionHarness();state.lostAck=true
 await assert.rejects(mod.saveIndustryEntry(stock,{up:['one'],down:[]},null),/acknowledgement/)
 await mod.saveIndustryEntry(stock,{up:['one'],down:[]},null);assert.equal(store.size,2)
 store.get('industryMap/2330').note='newer';const before=structuredClone(store)
 await assert.rejects(mod.saveIndustryEntry({...stock,note:'stale'},{up:[],down:[]},stock),/更新/);assert.deepEqual(store,before)
})
const merge=compile(read('src/lib/investorMeetingMerge.ts'))
function meetingsHarness(seed) {const h=transactionHarness(seed);return {...h,meetings:compile(read('src/lib/investorMeetings.ts'),{...h.bindings,validDates:merge.normalizeMeetingDates,mergeInvestorMeetings:merge.mergeInvestorMeetings})}}
test('meeting import merges latest concurrent dates and retry does not duplicate',async()=>{
 const {meetings,store,state}=meetingsHarness({'investorMeetingOverrides/2330-2026-09':{stockName:'台積電',addedDates:['2026-09-09'],removedDates:['2026-09-10']}})
 state.before=store=>store.get('investorMeetingOverrides/2330-2026-09').addedDates.push('2026-09-11')
 const inputs=[{stockCode:'2330',stockName:'台積電',yearMonth:'2026-09',dates:['2026-09-10']}]
 assert.equal(await meetings.addInvestorMeetingDates(inputs),1);assert.equal(await meetings.addInvestorMeetingDates(inputs),0)
 assert.deepEqual(store.get('investorMeetingOverrides/2330-2026-09').addedDates,['2026-09-09','2026-09-10','2026-09-11'])
 assert.deepEqual(store.get('investorMeetingOverrides/2330-2026-09').removedDates,[])
})
test('meeting import partial batch failure reports progress and resumes safely',async()=>{
 const {meetings,store,state}=meetingsHarness();state.failAt=2
 const inputs=Array.from({length:401},(_,i)=>({stockCode:String(i),stockName:String(i),yearMonth:'2026-09',dates:['2026-09-09']}))
 await assert.rejects(meetings.addInvestorMeetingDates(inputs),/已確認更新 400 組/);assert.equal(store.size,400)
 state.failAt=0;assert.equal(await meetings.addInvestorMeetingDates(inputs),1);assert.equal(store.size,401)
})

const response=(data,status=200)=>({ok:status>=200&&status<300,status,json:async()=>data})
test('Google insert uses stable ID and recovers concurrent duplicate without a second event',async()=>{
 const ids=[],remote=new Map()
 const mod=compile(read('netlify/functions/google-calendar-sync.js'),{authorizeGoogleRequest:async()=>null,process:{env:{}},fetch:async(url,options={})=>{
  if(url.includes('oauth2'))return response({access_token:'fixture'})
  if(url.includes('?'))return response({items:[]})
  if(options.method==='POST'){
   const body=JSON.parse(options.body);ids.push(body.id)
   if(remote.has(body.id))return response({},409)
   remote.set(body.id,{...body,updated:'2026-09-09T00:00:00Z'});return response(remote.get(body.id))
  }
  return response(remote.get(url.split('/').at(-1)))
 }})
 const run=async()=>JSON.parse((await mod.handleEvent({httpMethod:'POST',body:JSON.stringify({refreshToken:'fixture',calendarId:'c',events:[{id:'local',date:'2026-09-09',title:'retry'}]})})).body)
 assert.equal((await run()).created,1);const retry=await run()
 assert.equal(retry.skipped,1);assert.equal(retry.failed,0);assert.equal(ids[0],ids[1]);assert.match(ids[0],/^[0-9a-v]{5,1024}$/);assert.equal(remote.size,1)
})
test('Google pull recurring instances never inherit the parent local source ID',async()=>{
 const start={dateTime:'2026-09-09T10:00:00+08:00'},end={dateTime:'2026-09-09T11:00:00+08:00'}
 const items=[{id:'one',start,end,recurringEventId:'series',originalStartTime:start,extendedProperties:{private:{sourceId:'parent'}}},{id:'two',start,end,recurringEventId:'series',originalStartTime:start,extendedProperties:{private:{sourceId:'instance-two',sourceGoogleEventId:'two'}}}]
 const mod=compile(read('netlify/functions/google-calendar-pull.js'),{authorizeGoogleRequest:async()=>null,process:{env:{}},fetch:async url=>response(url.includes('oauth2')?{access_token:'fixture'}:{items})})
 const data=JSON.parse((await mod.handleEvent({httpMethod:'POST',body:JSON.stringify({refreshToken:'fixture',calendarId:'c'})})).body)
 assert.equal(data.events[0].sourceId,null);assert.equal(data.events[1].sourceId,'instance-two');assert.deepEqual(data.events[0].originalStartTime,start)
})
function googleHarness(local,pull,onFetch) {
 const h=transactionHarness({'calendarEvents/n':local})
 const mod=compile(read('src/lib/googleCalendar.ts').replaceAll('import.meta.env.VITE_GOOGLE_CLIENT_ID',"'fixture'"),{
 investAuth:{get currentUser(){return {uid:session.uid,getIdToken:async()=> 'fixture-id-token'}}},
  ...h.bindings,
  captureUserSession:()=>({...session,doc:(_,c,id)=>({path:c+'/'+id,id})}),
  runTransaction:(_,work)=>h.bindings.runTransaction(_,transaction=>work({
   get:ref=>transaction.get(ref.path),set:(ref,...args)=>transaction.set(ref.path,...args),
   update:(ref,...args)=>transaction.update(ref.path,...args),delete:ref=>transaction.delete(ref.path),
  })),
  getDocsFromServer:async()=>({docs:[{id:'n',data:()=>structuredClone(h.store.get('calendarEvents/n'))}]}),
  fetch:async(url,options)=>{
   if(url.includes('pull'))return response({events:pull})
   if(url.includes('sync')){if(onFetch)onFetch(h.store);const events=JSON.parse(options.body).events;return response({updated:events.length,links:events.map(e=>({id:e.id,googleEventId:'g',updatedAt:'2030-01-01T00:00:00Z'}))})}
   return response({calendarId:'fixture'})
  }
 })
 return {...h,run:()=>mod.performGoogleCalendarSync({calendarId:'fixture',refreshToken:'fixture',syncTypes:['personal']}),mod}
}
const localEvent={date:'2026-09-09',title:'old',type:'personal',googleEventId:'g',updatedAt:'2026-09-09T00:00:00Z',start:{date:'2026-09-09'},end:{date:'2026-09-10'}}
test('Google pull cannot overwrite or delete a concurrently edited local event',async()=>{
 for(const cancelled of [false,true]) {
  const h=googleHarness(localEvent,[{sourceId:'n',googleEventId:'g',title:'remote',date:'2026-09-09',description:'',updated:'2030',cancelled}])
  h.state.before=store=>store.get('calendarEvents/n').start={date:'2026-09-11'}
  const result=await h.run();assert.equal(result.failed,1);assert.equal(h.store.get('calendarEvents/n').title,'old');assert.equal(h.store.get('calendarEvents/n').start.date,'2026-09-11')
 }
})
test('Google push acknowledgement preserves concurrent local edit and marks it for the next sync',async()=>{
 const h=googleHarness(localEvent,[{sourceId:'n',googleEventId:'g',updated:'2000',cancelled:false}],store=>store.get('calendarEvents/n').title='edited during network')
 assert.equal((await h.run()).failed,0)
 assert.equal(h.store.get('calendarEvents/n').title,'edited during network');assert.equal(h.store.get('calendarEvents/n').googlePendingLocalChange,true)
})
test('Google series conversion replaces the local parent with occurrences without deleting the series',async()=>{
 const h=googleHarness({...localEvent,googleEventId:'series'},[{sourceId:null,googleEventId:'occurrence',recurringEventId:'series',date:'2026-09-09',title:'repeated',description:'',updated:'2030',start:localEvent.start,end:localEvent.end,cancelled:false}])
 const result=await h.run()
 assert.equal(result.failed,0)
 assert.equal(result.pulledDeleted,1);assert.equal(result.pulledCreated,1);assert.equal(result.pushedDeleted,0)
 assert.equal(h.store.has('calendarEvents/n'),false)
 assert.equal([...h.store.values()].some(e=>e.recurringEventId==='series'),true)
})
