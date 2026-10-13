import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto'
import { compile, read } from './helpers/compile.mjs'
import { invokeEventHandler } from '../netlify/lib/http-function.js'
const apiError=(statusCode,error,headers={})=>({statusCode,headers,body:JSON.stringify({error})})
const secrets=compile(read('netlify/lib/google-calendar-security.js'),{createHash,timingSafeEqual})
function oauthHarness() {
 const rows=new Map(),calls=[]
 const db={doc:path=>({path,set:async data=>rows.set(path,data)}),runTransaction:async fn=>fn({get:async ref=>({data:()=>rows.get(ref.path)}),set:(ref,data)=>rows.set(ref.path,data)})}
 const env={GOOGLE_CLIENT_ID:'fixture-client',GOOGLE_CLIENT_SECRET:'fixture-secret'}
 const state=compile(read('netlify/lib/google-oauth-state.js'),{createHash,createCipheriv,createDecipheriv,randomBytes,...secrets,process:{env},Buffer})
 let denied=null,exchangeFails=false
 const mod=compile(read('netlify/functions/google-calendar-auth.js'),{...state,...secrets,createHash,authorizeApiIdentity:async()=>denied||{uid:'A',authTime:100,db},getFirestore:()=>db,getProtectedApp:()=>({}),apiError,apiHeaders:{'Cache-Control':'private, no-store'},process:{env},fetch:async(url,init)=>{calls.push({url,init});if(exchangeFails)throw Error('private credential fixture');return Response.json({refresh_token:'fixture-refresh',access_token:'must-not-return'})}})
 const start=async()=>mod.handleEvent({httpMethod:'POST',queryStringParameters:{action:'connect'},headers:{authorization:'Bearer fixture'},body:JSON.stringify({clientState:'a'.repeat(64)})})
 const callback=(start,changes={})=>{const url=new URL(JSON.parse(start.body).url);return {httpMethod:'GET',queryStringParameters:{state:url.searchParams.get('state'),code:'fixture-code',...changes.query},headers:{cookie:start.headers['Set-Cookie'].split(';')[0],...changes.headers}}}
 return {...mod,...state,start,callback,calls,rows,deny:value=>denied=value,fail:()=>exchangeFails=true}
}
test('OAuth start uses Firebase identity, encrypted random state and an HttpOnly Secure cookie; callback remains same',async()=>{
 const h=oauthHarness(),start=await h.start(),url=new URL(JSON.parse(start.body).url)
 assert.equal(start.statusCode,200);assert.equal(url.origin,'https://accounts.google.com')
 assert.equal(url.searchParams.get('prompt'),'consent');assert.equal(url.searchParams.get('access_type'),'offline')
 assert.ok(url.searchParams.get('state'));assert.ok(!start.body.includes('fixture-secret'))
 assert.match(start.headers['Set-Cookie'],/HttpOnly; Secure; SameSite=Lax/)
 const result=await invokeEventHandler(new Request('https://example.test/auth?'+new URLSearchParams(h.callback(start).queryStringParameters),{headers:h.callback(start).headers}),h.handleEvent)
 const params=new URLSearchParams(new URL(result.headers.get('Location')).hash.slice(1))
 assert.equal(params.get('gcal_refresh_token'),'fixture-refresh');assert.equal(params.get('gcal_uid'),'A');assert.equal(params.get('gcal_auth_time'),'100');assert.equal(params.get('gcal_state'),'a'.repeat(64))
 assert.equal(params.get('gcal_access_token'),null);assert.ok(h.rows.size===0 || [...h.rows.values()].every(row=>row.stateHash==='consumed'))
 assert.equal(h.calls[0].init.body.get('redirect_uri'),url.searchParams.get('redirect_uri'))
 assert.match(result.headers.get('Set-Cookie'),/Max-Age=0/)
})
for(const mode of ['missing-state','tampered-state','missing-cookie','wrong-cookie','expired','replay','superseded'])test('OAuth '+mode+' stops before exchanging any new code',async()=>{
 const h=oauthHarness(),start=await h.start(),event=h.callback(start)
 if(mode==='missing-state')delete event.queryStringParameters.state
 if(mode==='tampered-state')event.queryStringParameters.state+='x'
 if(mode==='missing-cookie')event.headers={}
 if(mode==='wrong-cookie')event.headers.cookie='__Host-symbiosis-gcal=unrelated'
 if(mode==='expired')for(const row of h.rows.values())row.expiresAt=0
 if(mode==='replay')await h.handleEvent(event)
 if(mode==='superseded')await h.start()
 const before=h.calls.length,result=await h.handleEvent(event)
 assert.match(decodeURIComponent(result.headers.Location),/gcal_error=/);assert.equal(h.calls.length,before)
 assert.ok(!result.headers.Location.includes('fixture-refresh'))
})
test('encrypted OAuth state expires and rejects a modified authentication tag without trusting decoded UID',()=>{
 const h=oauthHarness(),value=h.createOAuthState('A',100,'a'.repeat(64),1000)
 const cookie='__Host-symbiosis-gcal='+value
 assert.equal(h.readOAuthState(value,cookie,1001).uid,'A')
 assert.throws(()=>h.readOAuthState(value,cookie,601000))
 assert.throws(()=>h.readOAuthState(value+'x',cookie+'x',1001))
})
test('authorization rejection never contacts Google; failed exchange does not return private error text',async()=>{
 const h=oauthHarness();h.deny(apiError(401,'login'));assert.equal((await h.start()).statusCode,401);assert.ok(h.rows.size===0 || [...h.rows.values()].every(row=>row.stateHash==='consumed'))
 h.deny(null);const start=await h.start();h.fail();const result=await h.handleEvent(h.callback(start));assert.ok(!JSON.stringify(result).includes('private credential fixture'));assert.ok(h.rows.size===0 || [...h.rows.values()].every(row=>row.stateHash==='consumed'))
})
function ownerHarness(saved={refreshToken:'old-valid',calendarId:'existing-calendar'}) {
 const reads=[];let identity={uid:'A',db:{doc:path=>({get:async()=>{reads.push(path);return{data:()=>saved}}})}}
 const mod=compile(read('netlify/lib/google-calendar-security.js'),{createHash,timingSafeEqual,apiError,authorizeApiIdentity:async()=>identity})
 return {...mod,reads,deny:value=>identity=value}
}
test('existing saved Google refresh token and calendar work without relinking',async()=>{
 const h=ownerHarness();assert.equal(await h.authorizeGoogleRequest({}, {refreshToken:'old-valid',calendarId:'existing-calendar'}),null)
 assert.deepEqual(h.reads,['users/A/settings/googleCalendarAuth'])
})
for(const payload of [{refreshToken:'other-user',calendarId:'existing-calendar'},{refreshToken:'old-valid',calendarId:'another-calendar'},{refreshToken:'old-valid'}])test('Google connection rejects a mismatched token, calendar or omitted saved ID',async()=>{
 const h=ownerHarness();assert.ok((await h.authorizeGoogleRequest({},payload,{ensure:true})).statusCode>=400)
})
test('ensure accepts a new connection without a calendar and authentication denies before reading user records',async()=>{
 const h=ownerHarness({refreshToken:'old-valid'});assert.equal(await h.authorizeGoogleRequest({}, {refreshToken:'old-valid'},{ensure:true}),null)
 const before=h.reads.length;h.deny(apiError(401,'login'));assert.equal((await h.authorizeGoogleRequest({},{})).statusCode,401);assert.equal(h.reads.length,before)
})
function frontend() {
 const storage=new Map(),calls=[],history=[];let current={uid:'A',getIdToken:async()=> 'firebase-token',getIdTokenResult:async()=>({claims:{auth_time:100}})},kms={uid:'kms-A'}
 const investAuth={get currentUser(){return current}},captureUserSession=()=>{const user=current,kmsUser=kms;return{uid:user.uid,assertActive(){if(current!==user||kms!==kmsUser)throw Error('session changed')},doc:()=> 'settings/auth'}}
 const window={location:{hash:'',pathname:'/calendar/settings',search:''},history:{replaceState:(...args)=>{history.push(args);window.location.hash=''}}}
 const mod=compile(read('src/lib/googleCalendar.ts'),{investAuth,captureUserSession,window,sessionStorage:{getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)},fetch:async(url,init)=>{calls.push({url,init});return Response.json({url:'https://accounts.google.com/o/oauth2/v2/auth?fixture'})}})
 const callback=async()=>{await mod.getGoogleCalendarAuthUrl();const pending=JSON.parse([...storage.values()][0]);window.location.hash='#'+new URLSearchParams({gcal_refresh_token:'new-token',gcal_uid:pending.uid,gcal_state:pending.clientState,gcal_auth_time:String(pending.authTime)});return pending}
 return {...mod,window,storage,calls,history,callback,switchUser:()=>current={...current,uid:'B'},relogin:()=>current={...current,getIdTokenResult:async()=>({claims:{auth_time:200}})},switchKms:()=>kms={uid:'kms-B'},changeDuringToken:()=>{current.getIdTokenResult=async()=>{kms={uid:'kms-B'};return{claims:{auth_time:100}}}}}
}
test('new Google start sends Firebase token in header only, saves no credentials in session storage and accepts bound callback once',async()=>{
 const h=frontend();await h.callback();assert.equal(h.calls[0].init.headers.get('Authorization'),'Bearer firebase-token')
 assert.ok(!h.calls[0].url.includes('firebase-token'));assert.ok(![...h.storage.values()][0].includes('firebase-token'))
 assert.deepEqual(await h.parseGoogleAuthRedirect(),{refreshToken:'new-token'});assert.equal(h.storage.size,0);assert.equal(h.window.location.hash,'')
 assert.equal(await h.parseGoogleAuthRedirect(),null)
})
for(const mode of ['switchUser','relogin','changeDuringToken','expired','wrong-state','legacy-fragment'])test('Google callback '+mode+' cannot save a token to the current account',async()=>{
 const h=frontend();await h.callback()
 if(typeof h[mode]==='function')h[mode]()
 if(mode==='expired'){const [key]=h.storage.keys(),row=JSON.parse(h.storage.get(key));row.expires=0;h.storage.set(key,JSON.stringify(row))}
 if(mode==='wrong-state')h.window.location.hash=h.window.location.hash.replace(/gcal_state=[a-f0-9]+/,'gcal_state=wrong')
 if(mode==='legacy-fragment')h.window.location.hash='#gcal_refresh_token=unbound-token'
 const result=await h.parseGoogleAuthRedirect();assert.ok(result.error);assert.equal(result.refreshToken,undefined);assert.equal(h.window.location.hash,'');assert.equal(h.storage.size,0)
})
test('reauthorization preserves calendar and selected sync types and refuses a switched session before any write',async()=>{
 const saved={refreshToken:'old',calendarId:'same-calendar',syncTypes:['personal','fomc']};let active=true,writes=0
 const session={doc:()=> 'auth',assertActive(){if(!active)throw Error('switched')}}
 const mod=compile(read('src/lib/googleCalendar.ts'),{investDB:{},captureUserSession:()=>session,runTransaction:async(_,fn)=>fn({get:async()=>({exists:()=>true,data:()=>saved}),set:(_,data)=>{writes++;Object.assign(saved,data)}})})
 await mod.saveGoogleCalendarAuth('new',session);assert.equal(saved.calendarId,'same-calendar');assert.deepEqual(saved.syncTypes,['personal','fomc']);active=false
 await assert.rejects(mod.saveGoogleCalendarAuth('bad',session),/switched/);assert.equal(writes,1)
})
for(const file of ['ensure','pull','sync'])test(file+' denies wrong-owner requests before contacting Google',async()=>{
 const mod=compile(read(`netlify/functions/google-calendar-${file}.js`),{authorizeGoogleRequest:async()=>apiError(403,'wrong owner'),fetch:()=>assert.fail('Unauthorized upstream request')})
 assert.equal((await mod.handleEvent({httpMethod:'POST',body:JSON.stringify({refreshToken:'x',calendarId:'y'})})).statusCode,403)
})
test('official FOMC date revisions target the existing generated all-day event; manual, timed and unversioned events remain untouched',()=>{
 const mod=compile(read('src/lib/googleCalendar.ts'))
 const event={id:'fomc-2026-12',date:'2026-12-09',type:'fomc',title:'FOMC'}
 const remote={sourceId:event.id,sourceType:'fomc',sourceKind:'generated',date:'2026-12-16',googleEventId:'original-google-id',etag:'v1',start:{date:'2026-12-16'}}
 assert.deepEqual(mod.generatedFomcRevision(event,remote),{googleEventId:'original-google-id',googleEtag:'v1',start:{date:'2026-12-09'},end:{date:'2026-12-10'}})
 for(const extra of [{sourceKind:'manual'},{start:{dateTime:'2026-12-16T09:00:00Z'}},{etag:''},{date:'2026-12-09'},{cancelled:true},{recurringEventId:'series'}])assert.deepEqual(mod.generatedFomcRevision(event,{...remote,...extra}),{})
})
test('FOMC date revision reaches the existing Google event with If-Match and preserves the new all-day dates',async()=>{
 const calls=[],mod=compile(read('netlify/functions/google-calendar-sync.js'),{authorizeGoogleRequest:async()=>null,process:{env:{}},fetch:async(url,init={})=>{
 calls.push({url,init})
 if(url.includes('oauth2'))return Response.json({access_token:'fixture'})
 if(init.method==='PATCH')return Response.json({id:'original',updated:'now'})
 return Response.json({etag:'v1',start:{date:'2026-12-16'},end:{date:'2026-12-17'}})
 }})
 const result=await mod.handleEvent({httpMethod:'POST',body:JSON.stringify({refreshToken:'fixture',calendarId:'fixture',events:[{id:'fomc-2026-12',type:'fomc',sourceKind:'generated',date:'2026-12-09',title:'FOMC',googleEventId:'original',googleEtag:'v1',start:{date:'2026-12-09'},end:{date:'2026-12-10'}}]})})
 assert.equal(JSON.parse(result.body).updated,1)
 const patch=calls.find(row=>row.init.method==='PATCH');assert.ok(patch.url.endsWith('/original'));assert.equal(patch.init.headers['If-Match'],'v1');assert.equal(JSON.parse(patch.init.body).start.date,'2026-12-09');assert.ok(!calls.some(row=>row.init.method==='POST'&&row.url.includes('/events')))
})
test('OAuth URL state is opaque to Google and cookies, tokens and identities never appear in diagnostics',async()=>{
 const h=oauthHarness(),start=await h.start(),state=new URL(JSON.parse(start.body).url).searchParams.get('state')
 assert.throws(()=>JSON.parse(Buffer.from(state.split('.')[1],'base64url').toString('utf8')))
 assert.ok(!start.body.includes('fixture-secret'));assert.ok(!start.body.includes('authTime'))
 const first=await h.handleEvent(h.callback(start,{query:{error:'private-provider-secret'}}))
 assert.ok(!first.headers.Location.includes('private-provider-secret'));assert.ok(!first.headers.Location.includes('gcal_refresh_token'))
})
test('a rejected reauthorization still displays the valid existing connection without replacing its token',async()=>{
 const source=read('src/pages/calendar/CalendarSettings.tsx'),start=source.indexOf('async function initializeGoogleConnection'),end=source.indexOf('export default function CalendarSettings')
 const auth={refreshToken:'old-valid',calendarId:'same-calendar',syncTypes:['personal']}
 const mod=compile(source.slice(start,end),{captureUserSession:()=>({assertActive(){}}),parseGoogleAuthRedirect:async()=>({error:'state rejected'}),saveGoogleCalendarAuth:()=>assert.fail('Rejected callbacks must never replace credentials'),getGoogleCalendarAuth:async()=>auth},'export { initializeGoogleConnection }')
 const result=await mod.initializeGoogleConnection();assert.equal(result.auth,auth);assert.equal(result.connected,false);assert.equal(result.error,'state rejected')
})
