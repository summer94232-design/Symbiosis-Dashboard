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




const calc=compile(read('src/lib/calc.ts'))
const row={code:'2330',currentMarketValue:10000,currentShares:100,price:100,targetWeightPct:0}
for(const shares of [0,100,999,1000,1500,2000]) test('F05 legal lot sale with holdings '+shares,()=>{
 const result=calc.calcPortfolioRebalance(200000,0,[{...row,currentShares:shares,currentMarketValue:shares*100}],{lotSize:1000,includeFees:true})
 const r=result.rows[0],sold=Math.floor(shares/1000)*1000
 assert.equal(r.estimatedShares,sold);assert.equal(result.totalSell,sold*100)
 assert.equal(r.projectedMarketValue,(shares-sold)*100)
 if(!sold){assert.equal(result.totalFees,0);assert.equal(result.totalTaxes,0);assert.equal(result.netCashRequired,0)}
})
test('F05 odd shares can fully liquidate without exceeding holdings',()=>{
 const r=calc.calcPortfolioRebalance(10000,0,[row],{lotSize:1}).rows[0]
 assert.equal(r.estimatedShares,100);assert.equal(r.projectedMarketValue,0)
})
for(const price of [null,undefined,NaN,Infinity])test('F05 missing price leaves cash and projected holdings unchanged '+price,()=>{
 for(const target of [0,100,200]){
 const r=calc.calcPortfolioRebalance(10000,target,[{...row,price,targetWeightPct:100}],{includeFees:true})
 assert.equal(r.netCashRequired,0);assert.equal(r.rows[0].projectedMarketValue,10000)
 }
})
function harness(){
 const state={uid:'a',day:'2026-09-08',existing:new Set(),writes:[],pause:null}
 const session=()=>{const uid=state.uid;const assertActive=()=>{if(state.uid!==uid)throw Error('changed')};return {uid,assertActive,doc:(_,col,id)=>{assertActive();return uid+'/'+col+'/'+id}}}
 const mod=compile(read('src/lib/snapshot.ts'),{
 captureUserSession:session,investDB:'db',toLocalDateString:()=>state.day,canRunAutoSnapshot:()=>true,isAfterTaiwanClose:()=>true,
 getDoc:async path=>{if(state.pause)await state.pause;return {exists:()=>state.existing.has(path),data:()=>({valuationQuality:'closing'})}},
 getDocFromServer:async()=>({exists:()=>false}),fetchTrades:async()=>[],fetchDividends:async()=>[],fetchCashflow:async()=>[],
 buildPortfolioSnapshot:()=>({holdings:[],netAssets:100,marketValue:0,cash:100,cashflow:[],marginDebt:0,missingPriceCodes:[],stalePriceCodes:[]}),
 validateSnapshotForWrite:()=>({valid:true}),invalidateAssetSnapshots:()=>{},
 runTransaction:async(_,fn)=>fn({get:async path=>({exists:()=>state.existing.has(path),data:()=>({valuationQuality:'closing'})}),set:path=>{state.writes.push(path);state.existing.add(path)}}),console:{info:()=>{},error:()=>{}}
 });return {state,run:mod.maybeAutoSnapshotToday}
}
test('F07 A covered does not skip B, deleted snapshot is rebuilt',async()=>{
 const {state,run}=harness();state.existing.add('a/assetSnapshots/'+state.day)
 assert.equal((await run()).status,'already-covered');state.uid='b'
 assert.equal((await run()).status,'written');state.existing.clear()
 assert.equal((await run()).status,'written');assert.equal(state.writes.length,2)
})
test('F07 throttle belongs to account and date',async()=>{
 const {state,run}=harness(),options={overwrite:true}
 assert.equal((await run(options)).status,'written');assert.equal((await run(options)).status,'throttled')
 state.uid='b';assert.equal((await run(options)).status,'written')
 state.day='2026-09-09';assert.equal((await run(options)).status,'written')
})
test('F07 lock covers initial read and old-account work cannot block new account',async()=>{
 const {state,run}=harness();let release;state.pause=new Promise(r=>{release=r})
 const first=run();assert.equal((await run()).status,'throttled')
 state.uid='b';state.pause=null;assert.equal((await run()).status,'written')
 release();assert.equal((await first).status,'error')
 assert.deepEqual(state.writes,['b/assetSnapshots/'+state.day])
 state.uid='a';assert.equal((await run()).status,'written')
})
function expression(name){
 const source=read('src/pages/invest/PortfolioPlanner.tsx'),ast=ts.createSourceFile('p.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX)
 let found;const visit=n=>{if(ts.isVariableDeclaration(n)&&n.name.getText(ast)===name)found=n.initializer;if(name==='effect'&&ts.isCallExpression(n)&&n.expression.getText(ast)==='useEffect')found=n.arguments[0];ts.forEachChild(n,visit)};visit(ast)
 assert.ok(found,name);return found.getText(ast)
}
const evaluate=(name,bindings)=>compile('export const value = '+expression(name),bindings).value
function scenarios(storage,owner,active){
 const state={saved:[],legacy:false,error:''},scenarioSession={uid:owner,assertActive:()=>{if(active.uid!==owner)throw Error('changed')}}
 const scenarioStorageKey=evaluate('scenarioStorageKey',{scenarioSession})
 const bindings={scenarioSession,scenarioStorageKey,localStorage:storage,LEGACY_SCENARIO_STORAGE_KEY:'invest:portfolio-planner:scenarios:v1',
 setHasLegacyScenarios:v=>state.legacy=v,setSavedScenarios:v=>state.saved=v,setError:v=>state.error=v,load:()=>{},syncVersion:0}
 return {state,load:evaluate('effect',bindings),save:evaluate('persistScenarios',bindings)}
}
test('F19 actual page load/save isolates accounts and leaves unowned legacy untouched',()=>{
 const data=new Map([['invest:portfolio-planner:scenarios:v1','[{"name":"legacy"}]']]),storage={getItem:k=>data.get(k)??null,setItem:(k,v)=>data.set(k,v)},active={uid:'a'}
 const a=scenarios(storage,'a',active);a.load();assert.deepEqual(a.state.saved,[]);assert.equal(a.state.legacy,true)
 assert.equal(a.save([{id:'a-plan'}]),true);active.uid='b'
 const b=scenarios(storage,'b',active);b.load();assert.deepEqual(b.state.saved,[]);b.save([{id:'b-plan'}]);b.save([])
 assert.equal(a.save([]),false);active.uid='a';a.load();assert.deepEqual(a.state.saved,[{id:'a-plan'}])
 assert.equal(data.get('invest:portfolio-planner:scenarios:v1'),'[{"name":"legacy"}]')
})
test('F19 storage failure does not pretend that a scenario was saved',()=>{
 const h=scenarios({getItem:()=>null,setItem:()=>{throw Error('quota')}},'a',{uid:'a'})
 assert.equal(h.save([{id:'x'}]),false);assert.deepEqual(h.state.saved,[]);assert.ok(h.state.error)
})
