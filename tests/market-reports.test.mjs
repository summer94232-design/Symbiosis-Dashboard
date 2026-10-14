import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { compile, read } from './helpers/compile.mjs'
import * as reports from '../netlify/lib/market-reports.js'
import * as google from '../netlify/lib/google-authorization.js'

const row = (date='2020-01-02',period='盤前',updatedAt=`${date} 08:58:00`,title='測試報告') => [date,period,title,'摘要','## 全文\n\n[來源](https://example.test/)',updatedAt]
const table = (...rows) => [reports.REPORT_HEADERS,...rows]
test('six-column parsing preserves Markdown, orders by report date/period, and chooses the newest revision',()=>{
 const result=reports.parseReportRows(table(row('2020-01-03','盤前'),row('2020-01-02','盤後','2020-01-02 18:04:00'),
  row('2020-01-03','盤後','2020-01-03 18:04:00','原版'),row('2020-01-03','盤後','2020-01-03 18:05:00','修訂'),row('2020-01-01')))
 assert.deepEqual(result.reports.map(r=>r.id),['2020-01-03:post','2020-01-03:pre','2020-01-02:post','2020-01-01:pre'])
 assert.equal(result.reports[0].title,'修訂');assert.match(result.reports[0].content,/\[來源\]/);assert.equal(result.invalidRows,0)
 const indented=row();indented[4]='    literal Markdown code\n\n'
 assert.equal(reports.parseReportRows(table(indented)).reports[0].content,indented[4])
})
test('invalid dates, date serials, missing trailing cells, invalid times and incomplete reports are not readable',()=>{
 const data=[row('2026-02-30'),row('2026-13-01'),row('2026-01-01','夜間'),row('2026-01-01','盤前','2026-01-01 24:00:00'),row().slice(0,5),[45000,'盤前','題','摘要','全文','2020-01-02 08:58:00'],['','','','','','']]
 const result=reports.parseReportRows(table(...data,row()))
 assert.equal(result.reports.length,1);assert.equal(result.invalidRows,6)
 assert.throws(()=>reports.parseReportRows([['日期','錯誤'],row()]))
 const conflict=row();conflict[4]='同一版本另一個全文'
 assert.throws(()=>reports.parseReportRows(table(row(),conflict)),/衝突/)
})
test('Sheets formatted single-digit hours remain readable and use canonical timestamps for revisions',()=>{
 const single=reports.parseReportRows(table(row('2020-01-02','盤前','2020-01-02 9:11:00')))
 assert.equal(single.invalidRows,0);assert.equal(single.reports[0].updatedAt,'2020-01-02 09:11:00')
 const revisions=reports.parseReportRows(table(row('2020-01-02','盤前','2020-01-02 9:11:00','早版'),row('2020-01-02','盤前','2020-01-02 10:01:00','新版')))
 assert.equal(revisions.reports[0].title,'新版')
 const midnight=reports.parseReportRows(table(row('2020-01-02','盤前','2020-01-02 0:01:00')))
 assert.equal(midnight.reports[0].updatedAt,'2020-01-02 00:01:00')
 const duplicate=row('2020-01-02','盤前','2020-01-02 09:11:00');duplicate[4]='不同版本全文'
 assert.throws(()=>reports.parseReportRows(table(row('2020-01-02','盤前','2020-01-02 9:11:00'),duplicate)),/衝突/)
 const invalid=reports.parseReportRows(table(row('2020-02-30','盤前','2020-02-30 9:11:00'),row('2020-01-02','盤前','2020-01-02 9:61:00'),row('2020-01-02','盤前','2020-01-02 24:11:00')))
 assert.equal(invalid.reports.length,0);assert.equal(invalid.invalidRows,3)
})
test('Taipei publication windows distinguish pending, late, weekend and verified holiday states',()=>{
 const latest=reports.parseReportRows(table(row('2026-10-13','盤後','2026-10-13 18:04:00'))).reports[0]
 const status=(time,rows=[latest],holidays=[])=>reports.reportDeliveryStatus(latest,rows,new Date(time),holidays)
 assert.match(status('2026-10-14T00:54:00Z'),/08:55～09:00/)
 assert.match(status('2026-10-14T00:55:00Z'),/產生中/)
 assert.match(status('2026-10-14T01:00:00Z'),/今日盤前尚未發布/)
 assert.match(status('2026-10-14T10:00:00Z'),/盤後報告產生中/)
 assert.match(status('2026-10-14T10:05:00Z'),/今日盤後尚未發布/)
 assert.match(status('2026-10-17T01:00:00Z'),/週末不執行/)
 assert.match(status('2026-10-14T01:00:00Z',[latest],['2026-10-14']),/休市日/)
 assert.doesNotMatch(status('2026-10-14T01:00:00Z',[latest,{date:'2026-10-14',period:'盤前'}]),/尚未發布/)
 const failed=reports.reportDeliveryStatus(latest,[latest],new Date('2026-10-14T01:00:00Z'),[],true)
 assert.match(failed,/更新狀態未確認/);assert.doesNotMatch(failed,/尚未發布/)
 assert.equal(reports.taipeiDate(new Date('2026-12-31T16:00:00Z')),'2027-01-01')
})

function harness() {
 const calls=[],rows=new Map(),sheets=new Map([['new_sheet',table(row(),row('2020-01-03','盤後','2020-01-03 18:04:00'))],['old_sheet',table(row())]])
 let uid='A',denied=null,pages=[{files:[{id:'new_sheet',createdTime:'2020-01-03T10:00:00Z'}]}]
 let user={email:google.GOOGLE_ACCOUNT_EMAIL,email_verified:true,sub:'google-fixture'},tokenStatus=200,tokenBody={access_token:'private-access'},upstreamFailure=null,sheetFailure=false
 const connection={googleEmail:google.GOOGLE_ACCOUNT_EMAIL,googleAccountId:'google-fixture',refreshToken:'private-refresh',grantedScopes:google.GOOGLE_AUTH_SCOPES}
 rows.set('users/A/settings/googleCalendarAuth',connection)
 rows.set('users/B/settings/googleCalendarAuth',{...connection,refreshToken:'private-refresh-B'})
 const db={doc:path=>({get:async()=>({data:()=>rows.get(path)})})}
 const api=compile(read('netlify/lib/api-access.js'),{createHash})
 const mod=compile(read('netlify/functions/market-reports.js'),{...reports,...google,createHash,cachedApi:api.cachedApi,
  apiError:api.apiError,apiHeaders:api.apiHeaders,authorizeApiIdentity:async()=>denied||{uid,db},validateAnnualEntry:()=>{throw Error('no holiday coverage')},
  process:{env:{GOOGLE_CLIENT_ID:'fixture-client',GOOGLE_CLIENT_SECRET:'fixture-secret'}},fetch:async(url,init)=>{
   calls.push({url:String(url),init})
   if(upstreamFailure)throw Error(upstreamFailure)
   if(String(url).includes('/token'))return Response.json(tokenBody,{status:tokenStatus})
   if(String(url).includes('/userinfo'))return Response.json(user)
   if(String(url).includes('/drive/v3/files')){
    const q=new URL(String(url)).searchParams;assert.match(q.get('q'),/name = '台股每日投資報告資料庫'/);assert.match(q.get('q'),/in owners/)
    assert.equal(q.get('pageSize'),'1');assert.equal(q.get('orderBy'),'createdTime desc')
    return Response.json(pages[Number(q.get('pageToken')||0)]||{files:[]})
   }
   const id=String(url).match(/spreadsheets\/([^/]+)\/values\/A1:F/)?.[1]
   if(id){if(sheetFailure)throw new DOMException('fixture timeout','TimeoutError');return Response.json({values:sheets.get(id)},{status:sheets.has(id)?200:404})}
   assert.fail('Unexpected upstream request')
  }})
 return {calls,rows,sheets,connection,read:(query={})=>mod.handleEvent({httpMethod:'GET',queryStringParameters:query}),
  setPages:value=>pages=value,setUid:value=>uid=value,deny:()=>denied=api.apiError(401,'登入'),
  setUser:value=>user={...user,...value},setToken:(body,status)=>{tokenBody=body;tokenStatus=status},fail:value=>upstreamFailure=value,failSheet:()=>sheetFailure=true}
}
test('dynamic read selects the first sheet, returns history metadata and keeps credentials off the wire',async()=>{
 const h=harness(),response=await h.read(),body=JSON.parse(response.body)
 assert.equal(response.statusCode,200);assert.equal(body.ownerUid,'A');assert.equal(body.source.id,'new_sheet');assert.equal(body.latest.id,'2020-01-03:post')
 assert.equal(body.reports.length,2);assert.equal(body.reports[0].content,undefined);assert.equal(body.selected,null)
 assert.ok(!response.body.includes('private-access'));assert.ok(!response.body.includes('private-refresh'))
 assert.equal(response.headers['Cache-Control'],'private, no-store')
 const historic=JSON.parse((await h.read({report:'2020-01-02:pre'})).body)
 assert.equal(historic.selected.id,'2020-01-02:pre');assert.equal(h.calls.length,4)
})
test('an empty new sheet falls back through Drive pagination to the previous readable sheet',async()=>{
 const h=harness();h.sheets.set('new_sheet',table())
 h.setPages([{files:[{id:'new_sheet'}],nextPageToken:'1'},{files:[{id:'old_sheet'}]}])
 const result=JSON.parse((await h.read()).body)
 assert.equal(result.source.id,'old_sheet');assert.equal(result.source.fallback,true)
})
test('live-formatted Sheets timestamps reach the latest report and historical reader',async()=>{
 const h=harness();h.sheets.set('new_sheet',table(row('2020-01-03','盤前','2020-01-03 9:11:00'),row('2020-01-02','盤前','2020-01-02 4:20:00')))
 const latest=await h.read(),body=JSON.parse(latest.body)
 assert.equal(latest.statusCode,200);assert.equal(body.source.fallback,false);assert.equal(body.source.invalidRows,0)
 assert.equal(body.latest.id,'2020-01-03:pre');assert.equal(body.latest.updatedAt,'2020-01-03 09:11:00')
 const historical=await h.read({report:'2020-01-02:pre'})
 assert.equal(historical.statusCode,200);assert.equal(JSON.parse(historical.body).selected.updatedAt,'2020-01-02 04:20:00')
})
test('missing or incomplete sources and future-dated reports never pretend to be a successful latest report',async()=>{
 for(const mode of ['none','bad-header','future']){
  const h=harness()
  if(mode==='none')h.setPages([{files:[]}])
  if(mode==='bad-header')h.sheets.set('new_sheet',[['日期','錯誤'],row()])
  if(mode==='future')h.sheets.set('new_sheet',table(row('2099-01-01')))
  const result=await h.read();assert.equal(result.statusCode,404);assert.equal(JSON.parse(result.body).code,'REPORT_EMPTY')
 }
})
test('authentication and missing scopes stop before Google; the source account is checked again on read',async()=>{
 const denied=harness();denied.deny();assert.equal((await denied.read()).statusCode,401);assert.equal(denied.calls.length,0)
 const missing=harness();missing.rows.set('users/A/settings/googleCalendarAuth',{refreshToken:'legacy'});assert.equal((await missing.read()).statusCode,403);assert.equal(missing.calls.length,0)
 for(const user of [{email:'other@example.test'},{sub:'another-id'},{email_verified:false}]){
  const h=harness();h.setUser(user);assert.equal((await h.read()).statusCode,403);assert.equal(h.calls.length,2)
 }
})
test('manual refresh replaces cached results; changing users or Google grants never reuses the prior cache',async()=>{
 const h=harness();await h.read()
 h.sheets.set('new_sheet',table(row('2020-01-04','盤後','2020-01-04 18:05:00')))
 assert.equal(JSON.parse((await h.read({refresh:'1'})).body).latest.date,'2020-01-04')
 assert.equal(JSON.parse((await h.read()).body).latest.date,'2020-01-04');assert.equal(h.calls.length,8)
 h.setUid('B');assert.equal(JSON.parse((await h.read()).body).ownerUid,'B');assert.equal(h.calls.length,12)
 h.rows.set('users/B/settings/googleCalendarAuth',{...h.connection,refreshToken:'new-private-refresh'})
 await h.read();assert.equal(h.calls.length,16)
})
test('read failures are distinct from missing reports and never expose upstream private error messages',async()=>{
 const h=harness();h.fail('private provider detail containing a token')
 const result=await h.read();assert.equal(result.statusCode,503);assert.ok(!result.body.includes('private provider detail'))
 const expired=harness();expired.setToken({error:'invalid_grant'},400);assert.equal((await expired.read()).statusCode,401)
 const unavailable=harness();unavailable.setToken({error:'private provider error'},503);assert.equal((await unavailable.read()).statusCode,503)
 const timeout=harness();timeout.failSheet();const timedOut=await timeout.read();assert.equal(timedOut.statusCode,503);assert.equal(JSON.parse(timedOut.body).code,'SOURCE_UNAVAILABLE')
 const missing=harness();assert.equal((await missing.read({report:'2020-02-01:pre'})).statusCode,404)
 assert.equal((await missing.read({report:'https://evil.test'})).statusCode,400)
})
test('forcing a shared cache refresh prevents an older pending loader from replacing it',async()=>{
 const {cachedApi}=compile(read('netlify/lib/api-access.js'))
 let finish;const old=cachedApi('fixture',60000,()=>new Promise(resolve=>{finish=resolve}))
 await Promise.resolve();assert.equal(await cachedApi('fixture',60000,async()=> 'new',true),'new')
 finish('old');assert.equal(await old,'old');assert.equal(await cachedApi('fixture',60000,()=>assert.fail('must reuse new')),'new')
})
test('frontend rejects account switches and mismatched response owners instead of publishing another users report',async()=>{
 let active=true,finish,calls=0
 const session={uid:'A',assertActive(){if(!active)throw Error('switched')}}
 const mod=compile(read('src/lib/marketReports.ts'),{captureUserSession:()=>session,authenticatedFetch:async(path,received)=>{
  calls++;assert.equal(received,session);assert.match(path,/market-reports/)
  return new Promise(resolve=>{finish=resolve})
 }})
 const pending=mod.fetchMarketReports();active=false;finish(Response.json({ownerUid:'A',latest:{},reports:[]}));await assert.rejects(pending,/switched/)
 active=true;const other=mod.fetchMarketReports();finish(Response.json({ownerUid:'B',latest:{},reports:[]}));await assert.rejects(other,/目前帳號/);assert.equal(calls,2)
})
