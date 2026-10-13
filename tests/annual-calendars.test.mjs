import test from 'node:test'
import assert from 'node:assert/strict'
import { compile,read } from './helpers/compile.mjs'
import { parseFomc,parseTwse,validateAnnualEntry,collectAnnualCalendars,updateAnnualCalendars,getAnnualCalendarLastSuccessAt,FED_URL,twseUrl } from '../netlify/lib/annual-calendars.js'
const now=new Date('2026-09-30T00:00:00Z'),html=read('tests/fixtures/annual-data/fomc-official.html'),twse=JSON.parse(read('tests/fixtures/annual-data/twse-2026.json').replace(/^\uFEFF/,''))
const verified=JSON.parse(read('tests/fixtures/annual-data/fomc-verified.json'))
test('actual Fed published HTML yields eight complete dates per year, handles notation votes, and matches verified 2025–2027 dates',()=>{
 assert.deepEqual(parseFomc(html,[2025,2026,2027],now),verified)
 assert.equal(verified[2025].dates.at(-1),'2025-12-10');assert.equal(verified[2026].dates.at(-1),'2026-12-09')
 assert.equal(parseFomc(html,[2028],now)[2028],undefined)
})
test('actual TWSE 2026 JSON distinguishes settlement-only days and contains all 16 weekday holidays',()=>{
 const row=parseTwse(twse,2026,now)
 assert.equal(row.dates.length,16);assert.equal(row.dates.includes('2026-02-12'),false);assert.equal(row.dates.includes('2026-02-13'),false);assert.equal(row.dates.includes('2026-02-16'),true)
 assert.equal(row.source,twseUrl(2026))
})
for(const mutate of [v=>v.queryYear=2027,v=>v.data=[],v=>v.total=0,v=>v.title='116 年市場開休市日期',v=>v.data[0][0]='2026-02-30',v=>v.data[0][2]='unknown wording',v=>v.data.push(v.data[0])])test('TWSE unpublished, wrong-year or damaged data never becomes a covered year',()=>{
 const value=structuredClone(twse);mutate(value);assert.throws(()=>parseTwse(value,2026,now))
})
for(const mutate of [v=>v.dates.pop(),v=>v.dates[0]='2027-02-30',v=>v.dates[1]=v.dates[0],v=>v.source='https://untrusted.test',v=>v.checkedAt='invalid'])test('unverified FOMC payload is rejected before installation',()=>{
 const row=structuredClone(verified[2027]);mutate(row);assert.throws(()=>validateAnnualEntry('fomc',2027,row))
})
test('parser refuses incomplete FOMC annual schedule and does not count isolated notation votes',()=>{
 const section=html.replace(/(<div[^>]+fomc-meeting__date[^>]*>)27-28/,'$1broken')
 assert.throws(()=>parseFomc(section,[2026],now))
 assert.deepEqual(parseFomc(html,[2025],now)[2025].dates,verified[2025].dates)
})
const publicFetch=async url=>url===FED_URL?new Response(html):Response.json(url===twseUrl(2026)?twse:{stat:'ok',queryYear:Number(url.match(/date=(\d{4})/)[1]),total:0,data:[]})
function store(initial={fomc:{},settlement:{}}){let value=structuredClone(initial),writes=0;return{db:{doc:path=>{assert.equal(path,'sharedData/annualCalendars');return{path}},runTransaction:async fn=>fn({get:async()=>({data:()=>value}),set:(_,row)=>{writes++;value=structuredClone(row)}})},value:()=>value,writes:()=>writes}}
test('automatic current/next-year checks validate publication and retain prior missing-year data independently',async()=>{
 const prior={fomc:{2024:{sentinel:true}},settlement:{2025:{sentinel:true}}},h=store(prior)
 const result=await updateAnnualCalendars(h.db,publicFetch,now)
 assert.deepEqual(result.fomcYears,['2025','2026','2027']);assert.deepEqual(result.settlementYears,['2026']);assert.ok(result.failures.includes('settlement-2027'))
 assert.deepEqual(h.value().settlement[2025],prior.settlement[2025]);assert.deepEqual(h.value().fomc[2024],prior.fomc[2024]);assert.equal(h.value().settlement[2027],undefined)
 assert.equal(h.writes(),1)
})
test('all official sources failing cause zero writes and preserve previous calendars',async()=>{
 const h=store({fomc:verified,settlement:{}}),before=h.value();await updateAnnualCalendars(h.db,async()=>{throw Error('private network fixture')},now)
 assert.equal(h.writes(),0);assert.deepEqual(h.value(),before)
})
test('a delayed older run cannot overwrite a newer verified date revision',async()=>{
 const next=structuredClone(verified);next[2027].checkedAt='2026-10-01T00:00:00Z';next[2027].dates[0]='2027-01-28'
 const h=store({fomc:next,settlement:{}});await updateAnnualCalendars(h.db,publicFetch,now)
 assert.equal(h.value().fomc[2027].dates[0],'2027-01-28')
})
test('Taipei New Year selects the new year even while UTC is still December',async()=>{
 const urls=[];await collectAnnualCalendars(async url=>{urls.push(url);throw Error('offline')},new Date('2026-12-31T16:01:00Z'))
 assert.ok(urls.includes(twseUrl(2028)));assert.ok(!urls.includes(twseUrl(2025)))
})
function frontend(data,fail=false){
 const calendar=compile(read('src/lib/calendarData.ts')),calc=compile(read('src/lib/calc.ts'),{},'export { addTwseSettlementDays }')
 const mod=compile(read('src/lib/annualCalendars.ts'),{...calendar,...calc,validateAnnualEntry,authenticatedFetch:async()=>{if(fail)throw Error('offline');return Response.json(data)}})
 return{...mod,calendar,calc}
}
test('validated online dates update actual FOMC events, coverage and T+2 before pages mount',async()=>{
 const settlement={...parseTwse(twse,2026,now),dates:['2027-01-01','2027-02-01','2027-03-01','2027-04-01','2027-05-03'],source:twseUrl(2027)}
 const h=frontend({fomc:{2027:verified[2027]},settlement:{2027:settlement}})
 await h.loadAnnualCalendars()
 assert.ok(h.calendar.FOMC_COVERED_YEARS.includes(2027));assert.equal(h.calendar.FOMC_DATES.filter(v=>v.date.startsWith('2027')).length,8)
 assert.ok(h.calc.TWSE_SETTLEMENT_COVERED_YEARS.includes(2027))
 assert.equal(h.calc.addTwseSettlementDays('2026-12-30',2).toISOString().slice(0,10),'2027-01-04')
})
test('invalid or unavailable annual response keeps bundled dates and missing coverage',async()=>{
 for(const fail of [true,false]){
  const row={...verified[2027],dates:['2027-01-01']},h=frontend({fomc:{2027:row},settlement:{}},fail)
  const before=structuredClone(h.calendar.FOMC_DATES)
  await h.loadAnnualCalendars();assert.deepEqual(h.calendar.FOMC_DATES,before);assert.ok(!h.calendar.FOMC_COVERED_YEARS.includes(2027))
 }
})
test('verified public dates survive offline reload; corrupt cached data cannot replace bundled calendars',async()=>{
 let cached=null
 const localStorage={getItem:()=>cached,setItem:(_,value)=>cached=value}
 const compileClient=(data,fail=false)=>{
 const calendar=compile(read('src/lib/calendarData.ts')),calc=compile(read('src/lib/calc.ts'))
 return{calendar,...compile(read('src/lib/annualCalendars.ts'),{...calendar,...calc,localStorage,validateAnnualEntry,authenticatedFetch:async()=>{if(fail)throw Error('offline');return Response.json(data)}})}
 }
 const online=compileClient({fomc:{2027:verified[2027]},settlement:{},lastSuccessAt:verified[2027].checkedAt});await online.loadAnnualCalendars();assert.ok(cached.includes('2027'))
 assert.equal(online.getAnnualCalendarLastSuccessAt(),verified[2027].checkedAt)
 assert.ok(!cached.includes('uid'));assert.ok(!cached.includes('token'))
 const offline=compileClient({},true);await offline.loadAnnualCalendars();assert.ok(offline.calendar.FOMC_COVERED_YEARS.includes(2027))
 assert.equal(offline.getAnnualCalendarLastSuccessAt(),verified[2027].checkedAt)
 cached=JSON.stringify({fomc:{2027:{...verified[2027],dates:[]}},settlement:{}})
 const corrupt=compileClient({},true);await corrupt.loadAnnualCalendars();assert.ok(!corrupt.calendar.FOMC_COVERED_YEARS.includes(2027))
 assert.equal(corrupt.getAnnualCalendarLastSuccessAt(),null)
})
test('annual reader provides the verified 2027 seed before the first scheduled run and returns only public date groups',async()=>{
 const seed=compile(read('netlify/lib/annual-calendar-seed.js')).annualCalendarSeed
 let saved={fomc:{},settlement:{},privateField:'must-not-return'}
 const mod=compile(read('netlify/functions/annual-calendars.js'),{annualCalendarSeed:seed,getAnnualCalendarLastSuccessAt,authorizeApiIdentity:async()=>({uid:'private-user',db:{doc:path=>{assert.equal(path,'sharedData/annualCalendars');return{get:async()=>({data:()=>saved})}}}}),cachedApi:async(_,__,load)=>load(),apiHeaders:{}})
 const response=await mod.handleEvent({httpMethod:'GET'}),data=JSON.parse(response.body)
 assert.equal(data.fomc[2027].dates.length,8);assert.deepEqual(Object.keys(data),['fomc','settlement','lastSuccessAt']);assert.equal(data.lastSuccessAt,null);assert.ok(!response.body.includes('must-not-return'));assert.ok(!response.body.includes('private-user'))
 saved={fomc:{2025:{...verified[2025],checkedAt:'2026-09-01T00:00:00Z'}},settlement:{}}
 const persisted=JSON.parse((await mod.handleEvent({httpMethod:'GET'})).body)
 assert.equal(persisted.lastSuccessAt,'2026-09-01T00:00:00.000Z')
 assert.equal(persisted.fomc[2027].dates.length,8)
})
test('last success uses only valid persisted rows; partial success advances it while source failures retain it',async()=>{
 const prior={fomc:verified,settlement:{}},h=store(prior),later=new Date('2026-09-30T10:18:07.964Z')
 assert.equal(getAnnualCalendarLastSuccessAt(prior),now.toISOString())
 await updateAnnualCalendars(h.db,publicFetch,later)
 assert.equal(getAnnualCalendarLastSuccessAt(h.value()),later.toISOString())
 await updateAnnualCalendars(h.db,async()=>{throw Error('offline')},new Date('2026-10-04T00:00:00Z'))
 assert.equal(getAnnualCalendarLastSuccessAt(h.value()),later.toISOString())
 assert.equal(getAnnualCalendarLastSuccessAt({fomc:{2027:{...verified[2027],dates:[],checkedAt:'2099-01-01T00:00:00Z'}}}),null)
 assert.equal(getAnnualCalendarLastSuccessAt(undefined),null)
})
test('opening pages, legacy seed data and invalid responses cannot invent or advance a success time',async()=>{
 for(const data of [
  {fomc:verified,settlement:{}},
  {fomc:{2027:{...verified[2027],dates:[]}},lastSuccessAt:now.toISOString()},
  {fomc:verified,lastSuccessAt:'2099-01-01T00:00:00Z'},
  {fomc:verified,lastSuccessAt:'invalid'},
 ]){
  const h=frontend(data);await h.loadAnnualCalendars();assert.equal(h.getAnnualCalendarLastSuccessAt(),null)
 }
 let fail=false,calls=0
 const h=compile(read('src/lib/annualCalendars.ts'),{applyFomcCalendar:()=>{},applySettlementCalendar:()=>{},validateAnnualEntry,authenticatedFetch:async()=>{if(fail)throw Error('offline');return Response.json({fomc:verified,lastSuccessAt:now.toISOString()})}})
 const unsubscribe=h.subscribeAnnualCalendarStatus(()=>calls++)
 await h.loadAnnualCalendars();assert.equal(calls,1);assert.equal(h.getAnnualCalendarLastSuccessAt(),now.toISOString())
 await h.loadAnnualCalendars();assert.equal(calls,1)
 fail=true;await h.loadAnnualCalendars();assert.equal(h.getAnnualCalendarLastSuccessAt(),now.toISOString());assert.equal(calls,1)
 unsubscribe()
})
test('status stays a single quiet footer, formats Taipei time and gives no invented date without records',async()=>{
 const {createRequire}=await import('node:module'),require=createRequire(import.meta.url)
 const {renderToStaticMarkup}=await import('react-dom/server')
 const React=await import('react')
 for(const timestamp of ['2026-09-30T10:18:07.964Z',null]){
  const mod=compile(read('src/components/AnnualCalendarStatus.tsx'),{require,useSyncExternalStore:(_,getSnapshot)=>getSnapshot(),subscribeAnnualCalendarStatus:()=>()=>{},getAnnualCalendarLastSuccessAt:()=>timestamp})
  const markup=renderToStaticMarkup(React.createElement(mod.default))
  assert.ok(markup.startsWith('<p '));assert.ok(!/button|role="alert"|border:/.test(markup))
  if(timestamp){assert.match(markup,/2026\/9\/30\s18:18/);assert.match(markup,/dateTime="2026-09-30T10:18:07.964Z"/)}
  else{assert.ok(markup.includes('尚無'));assert.ok(!markup.includes('<time'))}
 }
})
test('app startup waits for public calendars and ignores an old account or unmounted startup completion',async()=>{
 const {createRequire}=await import('node:module'),require=createRequire(import.meta.url)
 const values=[],pending=[];let notify,cleanup
 const source=read('src/main.tsx').split("ReactDOM.createRoot")[0]
 const mod=compile(source,{require,useState:()=>[undefined,value=>values.push(value)],useEffect:fn=>{cleanup=fn()},onBothAuthChanged:fn=>{notify=fn;return()=>{}},loadAnnualCalendars:()=>new Promise(resolve=>pending.push(resolve)),App:()=>null,Login:()=>null})
 mod.Root();notify({uid:'A'});notify({uid:'B'});pending[0]();await Promise.resolve();assert.ok(values.every(value=>value===undefined))
 pending[1]();await Promise.resolve();assert.equal(values.at(-1).uid,'B')
 notify({uid:'C'});cleanup();pending[2]();await Promise.resolve();assert.equal(values.at(-1),undefined)
})
test('official Apr/May cross-month meeting uses May ending date, not April day 1',()=>{
 const source=html.replace('<strong>May</strong>','<strong>Apr/May</strong>').replace('>6-7</div>','>30-1</div>')
 assert.equal(parseFomc(source,[2025],now)[2025].dates[2],'2025-05-01')
})
