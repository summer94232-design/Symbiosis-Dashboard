import test from 'node:test'
import assert from 'node:assert/strict'
import { handleQuoteBatch, parseBatchSymbols } from '../netlify/lib/fugle-quote-batch.js'
import { invokeEventHandler } from '../netlify/lib/http-function.js'
import { compile, read } from './helpers/compile.mjs'
const { readQuoteStream }=compile(read('src/lib/quoteStream.ts'))
const quote={symbol:'2330',name:'台積電',date:'2026-10-16',closePrice:100,lastUpdated:123}
const event=symbols=>({httpMethod:'POST',headers:{},body:JSON.stringify({kind:'quotes',symbols})})
const jsonStream=rows=>new Response(rows.map(row=>JSON.stringify(row)+'\n').join(''),{headers:{'Content-Type':'application/x-ndjson'}})
function fixture(overrides={}){const calls=[];return {calls,deps:{env:{FUGLE_API_KEY:'secret-canary'},reserveQuoteBudget:async(_db,count,_now,pool)=>{calls.push({count,pool});return {granted:count,retryAfter:70}},fetch:async()=>Response.json({...quote,extra:'secret-canary'}),...overrides}}}
async function rows(result){return (await new Response(result.body).text()).trim().split('\n').map(JSON.parse)}

test('batch validates size/symbols, deduplicates and authenticates once with per-stock units',async()=>{
 for(const invalid of [[],Array(21).fill('2330'),['../secret'],['2330',null],'2330'])assert.equal(parseBatchSymbols(invalid),null)
 assert.deepEqual(parseBatchSymbols(['2330','2330','2317']),['2330','2317'])
 const f=fixture(),access=[]
 const route=compile(read('netlify/functions/fugle-proxy.js'),{parseBatchSymbols,handleQuoteBatch:(symbols,identity)=>handleQuoteBatch(symbols,identity,f.deps),authorizeApiIdentity:async(...args)=>{access.push(args);return {db:{}}}})
 const response=await route.handleEvent(event(['2330','2330','2317']))
 assert.equal(access.length,1);assert.equal(access[0][1],'fugle');assert.equal(access[0][2],2);assert.equal(access[0][3],'POST')
 assert.equal(response.statusCode,200);await rows(response)
 assert.deepEqual(f.calls,[{count:2,pool:'quote'}])
 const denied=compile(read('netlify/functions/fugle-proxy.js'),{parseBatchSymbols,authorizeApiIdentity:async()=>({statusCode:401}),handleQuoteBatch:()=>assert.fail('no upstream access before auth')})
 assert.equal((await denied.handleEvent(event(['2330']))).statusCode,401)
})

test('batch key, provider budget and reservation failure stop before upstream access',async()=>{
 for(const [overrides,status] of [[{env:{}},503],[{reserveQuoteBudget:async()=>({granted:0,retryAfter:70})},429],[{reserveQuoteBudget:async()=>{throw Error('secret-canary')}},503]]){
  const f=fixture({...overrides,fetch:()=>assert.fail('must not fetch')});const result=await handleQuoteBatch(['2330'],{db:{}},f.deps)
  assert.equal(result.statusCode,status);assert.ok(!JSON.stringify(result).includes('secret-canary'))
 }
})

test('five upstream workers stream a fast holding before a slow one, reserve once, and whitelist rows',async()=>{
 let release;const slow=new Promise(done=>{release=done});let active=0,peak=0,started=0
 const f=fixture({fetch:async url=>{started++;peak=Math.max(peak,++active);if(url.endsWith('1000'))await slow;await new Promise(r=>setImmediate(r));active--;return Response.json({...quote,symbol:url.split('/').at(-1),extra:'secret-canary'})}})
 const symbols=Array.from({length:9},(_,i)=>String(1000+i)),result=await handleQuoteBatch(symbols,{db:{}},f.deps)
 const received=[];const pending=readQuoteStream(new Response(result.body,{headers:result.headers}),symbols,(symbol,value)=>received.push({symbol,value}),()=>{})
 await new Promise(r=>setTimeout(r,20));assert.ok(received.length>0);assert.ok(!received.some(r=>r.symbol==='1000'));assert.equal(peak,5)
 release();await pending;assert.equal(started,9);assert.equal(received.length,9);assert.equal(f.calls.length,1)
 assert.ok(!JSON.stringify(received).includes('secret-canary'));assert.ok(received.every(r=>r.value.quote.closePrice===100))
})

test('partial budget and provider errors settle each stock without replaying or leaking provider text',async()=>{
 let started=0
 const f=fixture({reserveQuoteBudget:async()=>({granted:2,retryAfter:70}),fetch:async()=>{started++;return new Response('secret-canary',{status:500})}})
 const data=await rows(await handleQuoteBatch(['2330','2317','0050'],{db:{}},f.deps))
 assert.equal(started,2);assert.equal(data.filter(r=>r.status===502).length,2);assert.equal(data.filter(r=>r.status===429).length,1);assert.deepEqual(data.at(-1),{done:true});assert.ok(!JSON.stringify(data).includes('secret-canary'))
})

test('stream parser accepts split Unicode frames, rejects omissions/duplicates/unrequested symbols, and keeps earlier rows',async()=>{
 const valid=[{symbol:'2330',status:200,quote},{symbol:'2317',status:429},{done:true}]
 const encoded=new TextEncoder().encode(valid.map(r=>JSON.stringify(r)+'\n').join(''))
 const stream=new ReadableStream({start(c){for(let i=0;i<encoded.length;i+=3)c.enqueue(encoded.slice(i,i+3));c.close()}})
 const accepted=[];await readQuoteStream(new Response(stream,{headers:{'Content-Type':'application/x-ndjson'}}),['2330','2317'],(s,r)=>accepted.push([s,r]),()=>{})
 assert.equal(accepted.length,2);assert.equal(accepted[1][1].error,'報價服務限流，請稍後再試')
 for(const invalid of [[valid[0]],[valid[0],valid[0],{done:true}],[{symbol:'9999',status:200,quote},{done:true}],[{done:true}]]){
  const kept=[];await assert.rejects(readQuoteStream(jsonStream(invalid),['2330'],(s)=>kept.push(s),()=>{}));if(invalid[0]===valid[0])assert.deepEqual(kept,['2330'])
 }
 await assert.rejects(readQuoteStream(new Response('{}'),['2330'],()=>{},()=>{}),/格式/)
 await assert.rejects(readQuoteStream(jsonStream(valid),['2330','2317'],()=>{},()=>{throw Error('account changed')}),/account changed/)
})

function client(fetcher){let account=true,calls=0;const session={assertActive(){if(!account)throw Error('account changed')}}
 const mod=compile(read('src/lib/fugle.ts'),{readQuoteStream,captureUserSession:()=>session,authenticatedFetch:async(...args)=>{calls++;return fetcher(...args)},isPositivePrice:v=>typeof v==='number'&&Number.isFinite(v)&&v>0,...compile(read('src/lib/quoteTiming.ts'))})
 return {...mod,calls:()=>calls,switchAccount:()=>{account=false}}
}

test('real batch client preserves symbol claims, overlapping single reads, progressive callbacks and 20-stock chunks',async()=>{
 let release;const wait=new Promise(done=>{release=done});const inputs=[]
 const h=client(async(_path,_session,init)=>{const {symbols}=JSON.parse(init.body);inputs.push(symbols);await wait;return jsonStream([...symbols.map(symbol=>({symbol,status:200,quote:{...quote,symbol}})),{done:true}])})
 const codes=Array.from({length:25},(_,i)=>String(1000+i)),published=[]
 const first=h.getMultipleQuoteObservations(codes,'2026-10-16T01:00:00Z',undefined,q=>published.push(q),true)
 const overlap=h.getMultipleQuoteObservations(codes.slice(0,3),'2026-10-16T01:00:01Z',undefined,undefined,true)
 const single=h.getQuote(codes.at(-1));release()
 const [a,b,c]=await Promise.all([first,overlap,single]);assert.equal(h.calls(),2);assert.deepEqual(inputs.map(v=>v.length),[20,5]);assert.equal(Object.keys(a).length,25);assert.equal(Object.keys(b).length,3);assert.equal(c.closePrice,100);assert.equal(published.length,25)
})

test('interrupted batch retains completed holding, fails missing tail, and never automatically repeats a metered request',async()=>{
 const h=client(async()=>jsonStream([{symbol:'2330',status:200,quote}]))
 const result=await h.getMultipleQuoteObservations(['2330','2317'],'2026-10-16T01:00:00Z',undefined,undefined,true)
 assert.equal(h.calls(),1);assert.equal(result['2330'].price,100);assert.equal(result['2317'].status,'failed')
})

test('batch account switch stops remaining reads/publications without changing a completed holding',async()=>{
 let release;const wait=new Promise(done=>{release=done});let h
 h=client(async()=>new Response(new ReadableStream({async start(c){c.enqueue(new TextEncoder().encode(JSON.stringify({symbol:'2330',status:200,quote})+'\n'));await wait;c.enqueue(new TextEncoder().encode(JSON.stringify({symbol:'2317',status:200,quote})+'\n'));c.close()}}),{headers:{'Content-Type':'application/x-ndjson'}}))
 const published=[];const pending=h.getMultipleQuoteObservations(['2330','2317'],'2026-10-16T01:00:00Z',undefined,q=>published.push(q),true)
 await new Promise(r=>setImmediate(r));h.switchAccount();release();const result=await pending
 assert.equal(result['2330'].price,100);assert.equal(result['2317'].status,'failed');assert.equal(published.filter(q=>q['2317']?.status==='success').length,0)
})


test('batch retries only an explicit transient pre-provider 503 and never retries missing configuration',async()=>{
 for(const permanent of [true,false]){
  let calls=0
  const h=client(async()=>{calls++;if(calls===1)return Response.json({error:permanent?'伺服器尚未設定 Fugle 報價金鑰':'報價額度暫時無法確認'},{status:503});return jsonStream([{symbol:'2330',status:200,quote},{symbol:'2317',status:200,quote},{done:true}])})
  const result=await h.getMultipleQuoteObservations(['2330','2317'],'2026-10-16T01:00:00Z',undefined,undefined,true)
  assert.equal(calls,permanent?1:2);assert.equal(result['2330'].status,permanent?'failed':'success')
 }
})

test('cancelling the stream aborts active upstream calls and never starts queued symbols',async()=>{
 const signals=[]
 const f=fixture({fetch:async(_url,{signal})=>{signals.push(signal);return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(Error('cancelled')),{once:true}))}})
 const result=await handleQuoteBatch(Array.from({length:9},(_,i)=>String(1000+i)),{db:{}},f.deps)
 const reader=result.body.getReader();await new Promise(r=>setImmediate(r));assert.equal(signals.length,5);await reader.cancel();await new Promise(r=>setImmediate(r));assert.ok(signals.every(signal=>signal.aborted));assert.equal(signals.length,5)
})


test('modern HTTP bridge delivers progressive bytes before the final batch response',async()=>{
 let release;const slow=new Promise(done=>{release=done});const f=fixture({fetch:async url=>{if(url.endsWith('2317'))await slow;return Response.json(quote)}})
 const response=await invokeEventHandler(new Request('https://example.test/.netlify/functions/fugle-proxy',{method:'POST',body:'{}'}),()=>handleQuoteBatch(['2330','2317'],{db:{}},f.deps))
 assert.equal(response.status,200);assert.match(response.headers.get('Content-Type'),/application\/x-ndjson/)
 const accepted=[];const pending=readQuoteStream(response,['2330','2317'],symbol=>accepted.push(symbol),()=>{})
 await new Promise(r=>setImmediate(r));assert.deepEqual(accepted,['2330']);release();await pending;assert.deepEqual(accepted,['2330','2317'])
})


test('batch transport retains the shared 55-stock client admission limit across twenty-stock chunks',async()=>{
 const chunks=[];const h=client(async(_path,_session,init)=>{const {symbols}=JSON.parse(init.body);chunks.push(symbols);return jsonStream([...symbols.map(symbol=>({symbol,status:200,quote:{...quote,symbol}})),{done:true}])})
 const result=await h.getMultipleQuoteObservations(Array.from({length:90},(_,i)=>String(1000+i)),'2026-10-16T01:00:00Z',undefined,undefined,true)
 assert.deepEqual(chunks.map(rows=>rows.length),[20,20,15]);assert.equal(Object.values(result).filter(q=>q.status==='success').length,55);assert.equal(Object.values(result).filter(q=>q.status==='failed').length,35)
})
