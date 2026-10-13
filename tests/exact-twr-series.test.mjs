import test from 'node:test'
import assert from 'node:assert/strict'
import { compile, read } from './helpers/compile.mjs'
const { calculateExactTwr, ledgerSignature } = compile(read('src/lib/exactTwr.ts'))
const { simpleRule } = compile(read('src/lib/recurrenceRules.ts'))
const report = () => ({ startDate: '2026-01-01', endDate: '2026-01-31', startValue: '100', endValue: '220', startSource: 'closing statement', endSource: 'closing statement', valuations: { deposit: { time: '10:00:00', before: '110', source: 'valuation at transfer' } }, ledgerSignature: '' })
const deposit = { id: 'deposit', date: '2026-01-15', amount: 100, type: 'in' }
test('exact TWR geometrically links around a deposit instead of treating it as end-period cash', () => {
    const result = calculateExactTwr(report(), [deposit])
    assert.ok(Math.abs(result.percent - (1.1 * 220 / 210 - 1) * 100) < 1e-10)
    assert.notEqual(result.percent, 20)
    assert.equal(result.segments[0].after, 210)
})
test('exact TWR handles withdrawals and multiple same-day flows in chronological order', () => {
    const r = report(); r.endValue = '220'
    r.valuations.withdraw = { time: '11:00:00', before: '231', source: 'transfer statement' }
    const result = calculateExactTwr(r, [{ id: 'withdraw', date: deposit.date, amount: 31, type: 'out' }, deposit])
    assert.ok(Math.abs(result.percent - 33.1) < 1e-9)
    assert.equal(result.segments[1].after, 200)
})
test('same-second flows need explicit ordering, never invented timestamps', () => {
    const r = report(); r.valuations.second = { time: '10:00:00', before: '210', source: 'same-second transfer' }
    const flows = [deposit, { ...deposit, id: 'second', amount: 10 }]
    assert.equal(calculateExactTwr(r, flows).percent, null)
    r.valuations.second.order = '2'
    assert.ok(Math.abs(calculateExactTwr(r, flows).percent - 10) < 1e-10)
})
test('missing valuations, blank inputs, missing provenance and malformed dates never produce exact TWR', () => {
    for (const change of [r => r.valuations = {}, r => r.startValue = '', r => r.endSource = '', r => r.valuations.deposit.source = '', r => r.valuations.deposit.time = '25:00:00', r => r.startDate = '2026-02-30']) {
        const r = report(); change(r); assert.equal(calculateExactTwr(r, [deposit]).percent, null)
    }
})
test('no-flow return, terminal total loss, negative NAV and emptied-account restarts', () => {
    const r = report(); r.endValue = '110'; assert.ok(Math.abs(calculateExactTwr(r, []).percent - 10) < 1e-10)
    r.endValue = '0'; assert.equal(calculateExactTwr(r, []).percent, -100)
    r.endValue = '-1'; assert.equal(calculateExactTwr(r, []).percent, null)
    r.endValue = '110'; r.valuations.deposit.before = '100'
    assert.equal(calculateExactTwr(r, [{ ...deposit, type: 'out' }]).percent, null)
})
test('end-of-day boundaries exclude start-day flows and include end-day flows', () => {
    const r = report()
    assert.equal(calculateExactTwr(r, [{ ...deposit, date: r.startDate }]).segments.length, 1)
    assert.equal(calculateExactTwr(r, [{ ...deposit, date: r.endDate }]).segments.length, 2)
})
test('invalid cash-flow data and duplicate IDs fail closed; signatures are stable but detect changes', () => {
    for (const flows of [[deposit, deposit], [{ ...deposit, amount: NaN }], [{ ...deposit, type: 'dividend' }], [{ ...deposit, id: '' }]]) assert.equal(calculateExactTwr(report(), flows).percent, null)
    assert.equal(ledgerSignature({b:2,a:1}), ledgerSignature({a:1,b:2}))
    assert.notEqual(ledgerSignature(deposit), ledgerSignature({...deposit,amount:101}))
})
test('simple rule editor preserves complex recurrence by refusing a lossy conversion', () => {
    assert.deepEqual(simpleRule(['RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=5']), { frequency:'WEEKLY',interval:'1',days:['MO','WE'],count:'5' })
    for (const lines of [['RRULE:FREQ=MONTHLY;BYDAY=2MO'], ['RRULE:FREQ=DAILY;UNTIL=20261231'], ['RRULE:FREQ=DAILY','EXDATE;VALUE=DATE:20260105']]) assert.equal(simpleRule(lines),null)
})
const master = () => ({id:'series',etag:'"v1"',summary:'weekly',start:{dateTime:'2026-01-01T09:00:00-05:00',timeZone:'America/New_York'},end:{dateTime:'2026-01-01T10:00:00-05:00',timeZone:'America/New_York'},recurrence:['RRULE:FREQ=WEEKLY'],status:'confirmed'})
function backend(options={}) {
    const calls=[],row=master(); let active=0,peak=0
    const apiError=(statusCode,error,headers={})=>({statusCode,headers,body:JSON.stringify({error})})
    const exports=compile(read('netlify/lib/google-calendar-series.js'),{
        authorizeGoogleRequest:async(event,input,optionsRoute)=>{assert.equal(optionsRoute.route,'calendarSeries');return options.denied?apiError(401,'denied'):null},apiError,apiHeaders:{},process:{env:{GOOGLE_CLIENT_ID:'fixture',GOOGLE_CLIENT_SECRET:'fixture'}},
        AbortSignal,fetch:async(url,init={})=>{
            calls.push({url,init})
            if(url.includes('oauth2'))return Response.json({access_token:'fixture'})
            if(url.endsWith('/series')) {
                if(init.method==='PATCH') {
                    if(options.patchConflict)return Response.json({}, {status:412})
                    row.recurrence=JSON.parse(init.body).recurrence;row.etag='"v2"';return Response.json(row)
                }
                return Response.json(options.notSeries?{...row,recurrence:undefined}:row)
            }
            active++;peak=Math.max(peak,active);await new Promise(r=>setTimeout(r,1));active--
            return Response.json({}, {status:options.inspectFailure?503:410})
        },
    })
    const request=(action,payload={})=>exports.handler({httpMethod:'POST',headers:{},body:JSON.stringify({action,seriesId:'series',calendarId:'fixture/calendar',refreshToken:'fixture-token',...payload})})
    return {...exports,request,calls,row,peak:()=>peak}
}
test('series endpoint rejects unauthorized callers before accessing Google', async()=>{
    const h=backend({denied:true});assert.equal((await h.request('read')).statusCode,401);assert.equal(h.calls.length,0)
})
test('read retrieves series master without mutating recurrence, original time zone or exceptions',async()=>{
    const h=backend(),response=await h.request('read');assert.equal(response.statusCode,200)
    assert.equal(JSON.parse(response.body).start.timeZone,'America/New_York')
    assert.equal(h.calls.length,2);assert.ok(h.calls[1].url.includes('fixture%2Fcalendar/events/series'))
})
test('series update patches only recurrence on master with If-Match and preserves EXDATE',async()=>{
    const h=backend(),recurrence=['RRULE:FREQ=DAILY;COUNT=4','EXDATE;TZID=America/New_York:20260102T090000']
    assert.equal((await h.request('update',{etag:'"v1"',recurrence})).statusCode,200)
    const patch=h.calls.find(c=>c.init.method==='PATCH')
    assert.equal(patch.url.split('/').at(-1),'series');assert.equal(patch.init.headers['If-Match'],'"v1"')
    assert.deepEqual(JSON.parse(patch.init.body),{recurrence})
})
test('stale version and concurrent Google changes reject without blind overwrites',async()=>{
    const h=backend();assert.equal((await h.request('update',{etag:'"old"',recurrence:['RRULE:FREQ=DAILY']})).statusCode,409)
    assert.equal(h.calls.filter(c=>c.init.method==='PATCH').length,0)
    const racing=backend({patchConflict:true});assert.equal((await racing.request('update',{etag:'"v1"',recurrence:['RRULE:FREQ=DAILY']})).statusCode,409)
})
test('replaying an acknowledged or lost-response series update is idempotent',async()=>{
    const h=backend(),payload={etag:'"v1"',recurrence:['RRULE:FREQ=DAILY']}
    assert.equal((await h.request('update',payload)).statusCode,200)
    assert.equal((await h.request('update',payload)).statusCode,200)
    assert.equal(h.calls.filter(c=>c.init.method==='PATCH').length,1)
})
test('malformed rules, missing ETag, non-series master and oversized inspection batches are rejected',async()=>{
    const h=backend()
    for(const recurrence of [[],['RRULE:FREQ=DAILY\nATTENDEE:x'],['RRULE:FREQ=WEEKLY;COUNT=2;UNTIL=20261231'],['DTSTART:20260101']]) assert.equal((await h.request('update',{etag:'"v1"',recurrence})).statusCode,400)
    assert.equal((await h.request('update',{recurrence:['RRULE:FREQ=DAILY']})).statusCode,400)
    assert.equal((await h.request('inspect',{ids:Array.from({length:51},(_,i)=>'series_'+i)})).statusCode,400)
    assert.equal((await backend({notSeries:true}).request('read')).statusCode,409)
})
test('old occurrences are checked individually with bounded concurrency; service failure is not deletion',async()=>{
    const h=backend(),res=await h.request('inspect',{ids:Array.from({length:10},(_,i)=>'series_'+i)})
    assert.equal(res.statusCode,200);assert.equal(JSON.parse(res.body).instances.length,10);assert.ok(h.peak()<=4)
    assert.equal((await backend({inspectFailure:true}).request('inspect',{ids:['series_1']})).statusCode,502)
})
test('series client stops before sending Google mutation after account switch during token retrieval',async()=>{
    let switched=false,calls=0
    const session={assertActive:()=>{if(switched)throw Error('account changed')}}
    const {seriesRequest}=compile(read('src/lib/googleSeries.ts'),{captureUserSession:()=>session,getGoogleCalendarAuth:async()=>({calendarId:'fixture',refreshToken:'fixture'}),investAuth:{currentUser:{getIdToken:async()=>{switched=true;return 'fixture'}}},fetch:async()=>{calls++}})
    await assert.rejects(seriesRequest('update','series'),/account changed/);assert.equal(calls,0)
})

test('malformed stored report and prototype-like document IDs cannot crash the TWR calculator',()=>{
 assert.equal(calculateExactTwr({...report(),valuations:null},[deposit]).percent,null)
 assert.equal(calculateExactTwr(report(),[{...deposit,id:'__proto__'}]).percent,null)
})

test('series refresh requires explicit cancellation and an unchanged local baseline before deleting',async()=>{
 for(const mode of ['cancelled','missing','changed','offline']) {
  let deleted=false,synced=0
  const original={recurringEventId:'series',googleEventId:'series_1',updatedAt:'2026-01-01',title:'local'}
  const snapshot={id:'local',ref:'local-ref',data:()=>({...original}),exists:()=>true}
  const session={assertActive:()=>{},col:()=> 'calendarEvents'}
  const mod=compile(read('src/lib/googleSeries.ts'),{
   investDB:{},captureUserSession:()=>session,getGoogleCalendarAuth:async()=>({calendarId:'fixture',refreshToken:'fixture',syncTypes:['personal']}),investAuth:{currentUser:{getIdToken:async()=> 'fixture'}},
   getDocsFromServer:async()=>({docs:[snapshot]}),ledgerSignature,invalidateCalendarEvents:()=>{},
   runTransaction:async(_,fn)=>fn({get:async()=> mode==='changed'?{...snapshot,data:()=>({...original,title:'new edit'})}:snapshot,delete:ref=>{assert.equal(ref,'local-ref');deleted=true},update:()=>assert.fail('must not update cancelled instance')}),
   performGoogleCalendarSync:async()=>{synced++;return {failed:0}},
   fetch:async()=> {if(mode==='offline')throw Error('offline');return Response.json({instances:mode==='missing'?[]:[{id:'series_1',status:'cancelled'}]})},
  })
  if(mode==='cancelled') {await mod.refreshGoogleSeries('series');assert.equal(deleted,true);assert.equal(synced,1)}
  else {await assert.rejects(mod.refreshGoogleSeries('series'));assert.equal(deleted,false);assert.equal(synced,0)}
 }
})

test('series response JSON arriving after an account switch is not published',async()=>{
 let switched=false
 const session={assertActive:()=>{if(switched)throw Error('account changed')}}
 const {seriesRequest}=compile(read('src/lib/googleSeries.ts'),{
  captureUserSession:()=>session,getGoogleCalendarAuth:async()=>({calendarId:'fixture',refreshToken:'fixture'}),investAuth:{currentUser:{getIdToken:async()=> 'fixture'}},
  fetch:async()=>({ok:true,json:async()=>{switched=true;return master()}}),
 })
 await assert.rejects(seriesRequest('read','series'),/account changed/)
})
