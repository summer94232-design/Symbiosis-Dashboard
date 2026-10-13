import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto'
import { compile, read } from './helpers/compile.mjs'
import { invokeEventHandler } from '../netlify/lib/http-function.js'
import * as googleAuthorization from '../netlify/lib/google-authorization.js'
const apiError=(statusCode,error,headers={})=>({statusCode,headers,body:JSON.stringify({error})})
const secrets=compile(read('netlify/lib/google-calendar-security.js'),{createHash,timingSafeEqual})
function oauthHarness() {
 const rows=new Map(),calls=[],writes=[]
 const store=(ref,data,options)=>{writes.push(ref.path);rows.set(ref.path,options?.merge?{...rows.get(ref.path),...data}:data)}
 const db={doc:path=>({path,set:async data=>store({path},data)}),runTransaction:async fn=>{
  const pending=[];const result=await fn({get:async ref=>({data:()=>rows.get(ref.path)}),set:(...args)=>pending.push(args)})
  pending.forEach(args=>store(...args));return result
 }}
 const env={GOOGLE_CLIENT_ID:'fixture-client',GOOGLE_CLIENT_SECRET:'fixture-secret'}
 const state=compile(read('netlify/lib/google-oauth-state.js'),{createHash,createCipheriv,createDecipheriv,randomBytes,...secrets,process:{env},Buffer})
 let denied=null,exchangeFails=false,exchangeHook=null,identity={uid:'A',authTime:100,db}
 let token={refresh_token:'fixture-refresh',access_token:'must-not-return',scope:googleAuthorization.GOOGLE_AUTH_SCOPES.join(' ')}
 let user={email:googleAuthorization.GOOGLE_ACCOUNT_EMAIL,email_verified:true,sub:'fixture-google-id'},userStatus=200
 const mod=compile(read('netlify/functions/google-calendar-auth.js'),{...state,...secrets,...googleAuthorization,createHash,authorizeApiIdentity:async()=>denied||identity,getFirestore:()=>db,getProtectedApp:()=>({}),apiError,apiHeaders:{'Cache-Control':'private, no-store'},process:{env},fetch:async(url,init)=>{
  calls.push({url,init});if(exchangeFails)throw Error('private credential fixture')
  if(url.includes('/userinfo'))return Response.json(user,{status:userStatus})
  if(exchangeHook)await exchangeHook()
  return Response.json(token)
 }})
 const start=async()=>mod.handleEvent({httpMethod:'POST',queryStringParameters:{action:'connect'},headers:{authorization:'Bearer fixture'},body:JSON.stringify({clientState:'a'.repeat(64)})})
 const callback=(start,changes={})=>{const url=new URL(JSON.parse(start.body).url);return {httpMethod:'GET',queryStringParameters:{state:url.searchParams.get('state'),code:'fixture-code',...changes.query},headers:{cookie:start.headers['Set-Cookie'].split(';')[0],...changes.headers}}}
 const complete=(clientState='a'.repeat(64))=>mod.handleEvent({httpMethod:'POST',queryStringParameters:{action:'complete'},headers:{authorization:'Bearer fixture'},body:JSON.stringify({clientState})})
 return {...mod,...state,start,callback,complete,calls,rows,writes,deny:value=>denied=value,fail:()=>exchangeFails=true,
  setIdentity:value=>identity={...identity,...value},setToken:value=>token={...token,...value},setUser:(value,status=200)=>{user={...user,...value};userStatus=status},onExchange:fn=>exchangeHook=fn}
}
test('OAuth start uses Firebase identity, encrypted random state and an HttpOnly Secure cookie; callback remains same',async()=>{
 const h=oauthHarness(),start=await h.start(),url=new URL(JSON.parse(start.body).url)
 assert.equal(start.statusCode,200);assert.equal(url.origin,'https://accounts.google.com')
 assert.equal(url.searchParams.get('prompt'),'consent select_account');assert.equal(url.searchParams.get('access_type'),'offline')
 assert.equal(url.searchParams.get('login_hint'),googleAuthorization.GOOGLE_ACCOUNT_EMAIL)
 assert.equal(url.searchParams.get('include_granted_scopes'),'true')
 assert.deepEqual(url.searchParams.get('scope').split(' '),googleAuthorization.GOOGLE_AUTH_SCOPES)
 assert.ok(!url.searchParams.get('scope').split(' ').includes('https://www.googleapis.com/auth/drive.readonly'))
 assert.ok(url.searchParams.get('state'));assert.ok(!start.body.includes('fixture-secret'))
 assert.match(start.headers['Set-Cookie'],/HttpOnly; Secure; SameSite=Lax/)
 const result=await invokeEventHandler(new Request('https://example.test/auth?'+new URLSearchParams(h.callback(start).queryStringParameters),{headers:h.callback(start).headers}),h.handleEvent)
 const params=new URLSearchParams(new URL(result.headers.get('Location')).hash.slice(1))
 assert.equal(params.get('gcal_refresh_token'),null);assert.equal(params.get('gcal_complete'),'1');assert.equal(params.get('gcal_uid'),'A');assert.equal(params.get('gcal_auth_time'),'100');assert.equal(params.get('gcal_state'),'a'.repeat(64))
 assert.equal(params.get('gcal_access_token'),null);assert.ok(!result.headers.get('Location').includes('must-not-return'))
 assert.equal(h.rows.has('users/A/settings/googleCalendarAuth'),false)
 const completed=await h.complete();assert.equal(completed.statusCode,200);assert.deepEqual(JSON.parse(completed.body),{connected:true})
 assert.equal(h.rows.get('users/A/settings/googleCalendarAuth').googleEmail,googleAuthorization.GOOGLE_ACCOUNT_EMAIL)
 assert.ok([...h.rows].filter(([path])=>path.startsWith('googleOAuthPending/')).every(([,row])=>row.phase==='complete'&&!row.grant))
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
 const h=oauthHarness();h.deny(apiError(401,'login'));assert.equal((await h.start()).statusCode,401);assert.equal(h.rows.size,0)
 h.deny(null);const start=await h.start();h.fail();const result=await h.handleEvent(h.callback(start));assert.ok(!JSON.stringify(result).includes('private credential fixture'));assert.ok([...h.rows.values()].every(row=>!row.grant))
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
 const mod=compile(read('src/lib/googleCalendar.ts'),{investAuth,captureUserSession,window,sessionStorage:{getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)},fetch:async(url,init)=>{calls.push({url,init});return Response.json(url.includes('action=complete')?{connected:true}:{url:'https://accounts.google.com/o/oauth2/v2/auth?fixture'})}})
 const callback=async()=>{await mod.getGoogleCalendarAuthUrl();const pending=JSON.parse([...storage.values()][0]);window.location.hash='#'+new URLSearchParams({gcal_complete:'1',gcal_uid:pending.uid,gcal_state:pending.clientState,gcal_auth_time:String(pending.authTime)});return pending}
 return {...mod,window,storage,calls,history,callback,switchUser:()=>current={...current,uid:'B'},relogin:()=>current={...current,getIdTokenResult:async()=>({claims:{auth_time:200}})},switchKms:()=>kms={uid:'kms-B'},changeDuringToken:()=>{current.getIdTokenResult=async()=>{kms={uid:'kms-B'};return{claims:{auth_time:100}}}}}
}
test('new Google start sends Firebase token in header only, saves no credentials in session storage and accepts bound callback once',async()=>{
 const h=frontend();await h.callback();assert.equal(h.calls[0].init.headers.get('Authorization'),'Bearer firebase-token')
 assert.ok(!h.calls[0].url.includes('firebase-token'));assert.ok(![...h.storage.values()][0].includes('firebase-token'))
 assert.deepEqual(await h.parseGoogleAuthRedirect(),{connected:true});assert.equal(h.storage.size,0);assert.equal(h.window.location.hash,'')
 assert.equal(h.calls[1].init.headers.get('Authorization'),'Bearer firebase-token')
 assert.deepEqual(Object.keys(JSON.parse(h.calls[1].init.body)),['clientState'])
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
test('server-verified reauthorization preserves the existing calendar and selected sync types',async()=>{
 const h=oauthHarness(),path='users/A/settings/googleCalendarAuth'
 h.rows.set(path,{refreshToken:'old',calendarId:'same-calendar',syncTypes:['personal','fomc']})
 const start=await h.start();await h.handleEvent(h.callback(start));assert.equal(h.rows.get(path).refreshToken,'old')
 assert.equal((await h.complete()).statusCode,200)
 const saved=h.rows.get(path);assert.equal(saved.refreshToken,'fixture-refresh');assert.equal(saved.calendarId,'same-calendar');assert.deepEqual(saved.syncTypes,['personal','fomc'])
 assert.deepEqual(saved.grantedScopes,googleAuthorization.GOOGLE_AUTH_SCOPES);assert.equal(saved.googleAccountId,'fixture-google-id')
})

for(const [name,user,status] of [
 ['wrong Google account',{email:'other@example.test'},200],
 ['unverified email',{email_verified:false},200],
 ['missing Google identity',{sub:''},200],
 ['failed Google identity lookup',{},403],
])test(name+' cannot replace the existing connection or return credentials',async()=>{
 const h=oauthHarness(),path='users/A/settings/googleCalendarAuth',old={refreshToken:'old-valid',calendarId:'same-calendar',syncTypes:['personal']}
 h.rows.set(path,old);h.setUser(user,status)
 const start=await h.start(),result=await h.handleEvent(h.callback(start))
 const params=new URLSearchParams(new URL(result.headers.Location).hash.slice(1))
 assert.match(params.get('gcal_error'),/請使用/);assert.equal(params.get('gcal_complete'),null)
 assert.equal(h.rows.get(path),old);assert.ok(!result.headers.Location.includes('fixture-refresh'))
 assert.ok((await h.complete()).statusCode>=400);assert.equal(h.rows.get(path),old)
})

for(const scope of googleAuthorization.GOOGLE_DATA_SCOPES)test('declining '+scope+' preserves the old token and stops before identity lookup',async()=>{
 const h=oauthHarness(),path='users/A/settings/googleCalendarAuth'
 h.rows.set(path,{refreshToken:'old-valid',calendarId:'same-calendar'})
 h.setToken({scope:googleAuthorization.GOOGLE_AUTH_SCOPES.filter(value=>value!==scope).join(' ')})
 const start=await h.start(),result=await h.handleEvent(h.callback(start))
 assert.match(decodeURIComponent(result.headers.Location),/請同時允許/)
 assert.equal(h.calls.length,1);assert.equal(h.rows.get(path).refreshToken,'old-valid')
 assert.ok((await h.complete()).statusCode>=400)
})

for(const token of [{scope:undefined},{refresh_token:''},{access_token:''}])test('missing usable grant data never saves an authorization',async()=>{
 const h=oauthHarness();h.setToken(token)
 const start=await h.start(),result=await h.handleEvent(h.callback(start))
 assert.ok(new URLSearchParams(new URL(result.headers.Location).hash.slice(1)).get('gcal_error'))
 assert.equal(h.rows.has('users/A/settings/googleCalendarAuth'),false);assert.ok((await h.complete()).statusCode>=400)
})

for(const mode of ['other-firebase-user','relogin','wrong-client-state','expired'])test('completion '+mode+' never writes the verified grant to a user record',async()=>{
 const h=oauthHarness(),start=await h.start();await h.handleEvent(h.callback(start))
 if(mode==='other-firebase-user')h.setIdentity({uid:'B'})
 if(mode==='relogin')h.setIdentity({authTime:200})
 if(mode==='expired')for(const row of h.rows.values())row.expiresAt=0
 const result=await h.complete(mode==='wrong-client-state'?'b'.repeat(64):undefined)
 assert.ok(result.statusCode>=400);assert.ok(!h.writes.some(path=>path.startsWith('users/')))
 assert.ok(!JSON.stringify(result).includes('fixture-refresh'))
})

test('a new authorization started during code exchange supersedes the old callback',async()=>{
 const h=oauthHarness(),start=await h.start()
 h.onExchange(()=>h.start())
 const result=await h.handleEvent(h.callback(start))
 assert.ok(new URLSearchParams(new URL(result.headers.Location).hash.slice(1)).get('gcal_error'))
 assert.ok((await h.complete()).statusCode>=400);assert.ok(!h.writes.some(path=>path.startsWith('users/')))
})

test('completion is idempotent after a lost response and cannot resurrect a disconnected grant',async()=>{
 const h=oauthHarness(),start=await h.start();await h.handleEvent(h.callback(start))
 assert.equal((await h.complete()).statusCode,200)
 const writes=h.writes.length
 assert.equal((await h.complete()).statusCode,200);assert.equal(h.writes.length,writes)
 h.rows.delete('users/A/settings/googleCalendarAuth')
 assert.ok((await h.complete()).statusCode>=400);assert.equal(h.writes.length,writes)
})

test('new connection gets default sync labels while a conflicting known Google identity stays intact',async()=>{
 const h=oauthHarness(),start=await h.start();await h.handleEvent(h.callback(start));await h.complete()
 assert.deepEqual(h.rows.get('users/A/settings/googleCalendarAuth').syncTypes,['investor','personal'])
 const previous={refreshToken:'other-existing-token',calendarId:'old-calendar',googleAccountId:'different-google-identity'}
 const next=await h.start();h.rows.set('users/A/settings/googleCalendarAuth',previous)
 await h.handleEvent(h.callback(next));assert.ok((await h.complete()).statusCode>=400)
 assert.equal(h.rows.get('users/A/settings/googleCalendarAuth'),previous)
})

test('client-supplied email, scopes and token cannot substitute for the server-verified grant',async()=>{
 const h=oauthHarness(),start=await h.start();await h.handleEvent(h.callback(start))
 const result=await h.handleEvent({httpMethod:'POST',queryStringParameters:{action:'complete'},body:JSON.stringify({
  clientState:'a'.repeat(64),refreshToken:'attacker-token',googleEmail:'other@example.test',grantedScopes:['https://www.googleapis.com/auth/drive'],
 })})
 assert.equal(result.statusCode,200)
 const saved=h.rows.get('users/A/settings/googleCalendarAuth')
 assert.equal(saved.googleEmail,googleAuthorization.GOOGLE_ACCOUNT_EMAIL);assert.equal(saved.refreshToken,'fixture-refresh')
 assert.deepEqual(saved.grantedScopes,googleAuthorization.GOOGLE_AUTH_SCOPES)
})

test('report permission indicators require the verified account and both read permissions',()=>{
 const {hasGoogleSheetsAuthorization,hasGoogleDriveSearchAuthorization,hasGoogleReportAuthorization,GOOGLE_ACCOUNT_EMAIL,GOOGLE_SHEETS_SCOPE,GOOGLE_DRIVE_SEARCH_SCOPE}=googleAuthorization
 for(const connection of [null,{refreshToken:'legacy'},{googleEmail:'other@example.test',grantedScopes:googleAuthorization.GOOGLE_AUTH_SCOPES}])assert.equal(hasGoogleReportAuthorization(connection),false)
 const sheetOnly={googleEmail:GOOGLE_ACCOUNT_EMAIL,grantedScopes:[GOOGLE_SHEETS_SCOPE]}
 assert.equal(hasGoogleSheetsAuthorization(sheetOnly),true);assert.equal(hasGoogleDriveSearchAuthorization(sheetOnly),false);assert.equal(hasGoogleReportAuthorization(sheetOnly),false)
 assert.equal(hasGoogleReportAuthorization({...sheetOnly,grantedScopes:[GOOGLE_SHEETS_SCOPE,GOOGLE_DRIVE_SEARCH_SCOPE]}),true)
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
 const mod=compile(source.slice(start,end),{captureUserSession:()=>({assertActive(){}}),parseGoogleAuthRedirect:async()=>({error:'state rejected'}),getGoogleCalendarAuth:async()=>auth},'export { initializeGoogleConnection }')
 const result=await mod.initializeGoogleConnection();assert.equal(result.auth,auth);assert.equal(result.connected,false);assert.equal(result.error,'state rejected')
})
