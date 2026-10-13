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


const dates = compile(read('src/lib/date.ts'))
const calc = compile(read('src/lib/calc.ts'))
const policy = compile(read('src/lib/pricePolicy.ts'), dates)
const portfolio = compile(read('src/lib/portfolioSnapshot.ts'), { ...dates, ...calc, ...policy })
const asOf = '2026-09-07'
const obs = (price, overrides = {}) => ({ price, requestedAt: '2026-09-07T02:00:00.000Z', fetchedAt: '2026-09-07T02:00:01.000Z',
    sourceDate: asOf, sourceUpdatedAt: 100, isFinalClose: true, status: price === null ? 'failed' : 'success', priceType: 'trade', ...overrides })
const buy = (overrides = {}) => ({id:'b',date:'2026-01-01',code:'2330',name:'fixture',type:'buy',price:100,shares:1000,total:100000,fee:0,tax:0,...overrides})
const div = (overrides = {}) => ({date:asOf,code:'2330',name:'fixture',cashDividend:5000,stockDividend:100,...overrides})
const balance = (overrides = {}) => portfolio.buildPortfolioSnapshot({asOf,trades:[buy()],cashflow:[{date:'2026-01-01',type:'in',amount:100000}],dividends:[],savedPrices:{2330:100},...overrides})

test('F11 partial failure retains the old price only as cache and cannot certify it as current', () => {
    const saved=policy.mergeQuoteObservations({2330:100,2317:50,_updatedAt:'2026-09-06T02:00:00Z'}, {'2330':obs(110),'2317':obs(null)})
    assert.equal(saved['2317'],50)
    assert.deepEqual(policy.stalePriceCodes(['2330','2317'],saved,asOf),['2317'])
    const snap=balance({trades:[buy(),buy({id:'b2',code:'2317'})],savedPrices:saved})
    assert.equal(snap.holdings.find(h=>h.code==='2317').currentPrice,null)
    assert.equal(snap.priceUpdatedAt,'')
})
test('F11 all failure does not advance successful timestamp', () => {
    const saved=policy.mergeQuoteObservations({2330:100,_updatedAt:'2026-09-06T02:00:00Z'}, {'2330':obs(null)})
    assert.equal(saved._updatedAt,'2026-09-06T02:00:00Z')
    assert.deepEqual(policy.stalePriceCodes(['2330'],saved,asOf),['2330'])
})
test('F11 refreshing a watchlist stock cannot freshen a held stock', () => {
    const saved=policy.mergeQuoteObservations({2330:100}, {'2317':obs(110)})
    assert.deepEqual(policy.stalePriceCodes(['2330'],saved,asOf),['2330'])
})
test('F11 late success and late failure both leave newer price and status intact', () => {
    const newer=obs(120,{requestedAt:'2026-09-07T03:00:00.000Z',sourceUpdatedAt:200})
    const saved=policy.mergeQuoteObservations({}, {'2330':newer})
    for(const old of [obs(110),obs(null)]) assert.deepEqual(policy.mergeQuoteObservations(saved,{'2330':old}),saved)
})
test('F11 regressed source tick is not made fresh, including after a failed request', () => {
    let saved=policy.mergeQuoteObservations({}, {'2330':obs(120,{sourceUpdatedAt:200})})
    saved=policy.mergeQuoteObservations(saved,{'2330':obs(null,{requestedAt:'2026-09-07T03:00:00.000Z',sourceDate:'',sourceUpdatedAt:null})})
    saved=policy.mergeQuoteObservations(saved,{'2330':obs(90,{requestedAt:'2026-09-07T04:00:00.000Z',sourceUpdatedAt:100})})
    assert.equal(saved['2330'],120)
    assert.equal(saved._quotes['2330'].status,'stale')
})
for(const [name,quote] of [
    ['old source date',obs(100,{sourceDate:'2026-09-04'})],
    ['unknown date',obs(100,{sourceDate:''})],
    ['old fetch date',obs(100,{fetchedAt:'2026-09-06T02:00:00.000Z'})],
]) test('F11 snapshot rejects '+name,()=>{
    assert.deepEqual(policy.stalePriceCodes(['2330'],policy.mergeQuoteObservations({}, {'2330':quote}),asOf),['2330'])
})
test('F11 all held prices current; legacy table timestamp alone is insufficient',()=>{
    assert.deepEqual(policy.stalePriceCodes(['2330'],policy.mergeQuoteObservations({}, {'2330':obs(100)}),asOf),[])
    assert.deepEqual(policy.stalePriceCodes(['2330'],policy.mergeQuoteObservations({}, {'2330':obs(100,{priceType:'reference'})}),asOf),[])
    assert.deepEqual(policy.stalePriceCodes(['2330'],{2330:100,_updatedAt:'2026-09-07T02:00:00Z'},asOf),['2330'])
})
test('F11 stale UI numeric override cannot replace a newer persisted price',()=>{
    const saved=policy.mergeQuoteObservations({}, {'2330':obs(120)})
    assert.equal(balance({savedPrices:saved,priceOverrides:{2330:90}}).holdings[0].currentPrice,120)
})
test('F12 future buy, sell, cashflow and dividend cannot enter today totals',()=>{
    const base=balance()
    const future=balance({trades:[buy(),buy({id:'future-buy',date:'2099-01-01',isMargin:true}),buy({id:'future-sell',date:'2099-02-01',type:'sell'})],
        cashflow:[{date:'2026-01-01',type:'in',amount:100000},{date:'2099-01-01',type:'in',amount:10000},{date:'2099-01-01',type:'out',amount:20000}],dividends:[div({date:'2099-01-01'})]})
    for(const key of ['cash','marketValue','netAssets','marginDebt','realizedPnL']) assert.equal(future[key],base[key],key)
    assert.equal(future.holdings[0].shares,1000)
})
test('F12 announcement never books even after the ex-dividend date',()=>{
    const result=balance({dividends:[div({date:'2026-08-01',status:'announced',cashPaymentDate:asOf,stockDistributionDate:asOf})]})
    assert.equal(result.cash,0);assert.equal(result.holdings[0].shares,1000)
})
test('F12 cash payment and share distribution become effective independently and inclusively',()=>{
    const dividends=[div({date:'2026-08-01',status:'confirmed',cashPaymentDate:'2026-09-08',stockDistributionDate:'2026-09-09'})]
    assert.equal(balance({dividends}).cash,0)
    const cashDay=balance({dividends,asOf:'2026-09-08'})
    assert.equal(cashDay.cash,5000);assert.equal(cashDay.holdings[0].shares,1000)
    const shareDay=balance({dividends,asOf:'2026-09-09'})
    assert.equal(shareDay.cash,5000);assert.equal(shareDay.holdings[0].shares,1100)
})
test('F12 legacy dividend date remains effective on that date',()=>{
    const result=balance({dividends:[div()]})
    assert.equal(result.cash,5000);assert.equal(result.holdings[0].shares,1100)
})
test('F12 stock distribution is inserted at actual date before subsequent sale',()=>{
    const sell=buy({id:'sell',date:'2026-09-09',type:'sell',shares:1100,total:110000})
    const result=balance({asOf:'2026-09-09',trades:[buy(),sell],dividends:[div({date:'2026-08-01',cashDividend:0,stockDistributionDate:'2026-09-08'})]})
    assert.equal(result.holdings.length,0)
    assert.equal(result.realizedPnL,10000)
})
test('F12 invalid or missing cashflow dates are excluded from current cash',()=>{
    assert.equal(balance({cashflow:[{type:'in',amount:100000},{date:'2026-02-30',type:'in',amount:20000}]}).cash,-100000)
})
test('F12 same-day future sell does not alter earlier day-trade matching',()=>{
    const result=balance({trades:[buy({date:'2026-09-07'}),buy({id:'s',date:'2026-09-08',type:'sell',price:110,total:110000})]})
    assert.equal(result.realizedPnL,0);assert.equal(result.holdings[0].shares,1000)
})
test('F12 historical snapshot cash reconstruction uses actual payment date',()=>{
    const snapshots=[{date:'2026-09-07',totalAssets:100000,marketValue:0,cash:0}]
    const result=calc.reconcileSnapshotBreakdowns(snapshots,[buy()],[div({date:'2026-08-01',cashPaymentDate:'2026-09-08'})],[{date:'2026-01-01',type:'in',amount:100000}])
    assert.equal(result[0].cash,0)
})

for (const scenario of ['complete','intraday','partial','all failed','watchlist only','legacy','reference','old date']) test('F11 real auto-snapshot path: '+scenario,async()=>{
    const writes=[];let priceReads=0
    const incoming=scenario==='complete'?{'2330':obs(100),'2317':obs(50)}
        :scenario==='intraday'?{'2330':obs(100,{isFinalClose:false}),'2317':obs(50,{isFinalClose:false})}
        :scenario==='reference'?{'2330':obs(100,{priceType:'reference'}),'2317':obs(50)}
        :scenario==='old date'?{'2330':obs(100,{sourceDate:'2026-09-04'}),'2317':obs(50)}
        :scenario==='partial'?{'2330':obs(100),'2317':obs(null)}
        :scenario==='all failed'?{'2330':obs(null),'2317':obs(null)}
        :scenario==='watchlist only'?{'0050':obs(50)}:{}
    const saved=policy.mergeQuoteObservations({2330:100,2317:50,_updatedAt:'2026-09-07T02:00:00Z'},incoming)
    const mod=compile(read('src/lib/snapshot.ts'),{
        investDB:'db',captureUserSession:()=>({assertActive:()=>{},doc:(_,col,id)=>col+'/'+id}),
        getDoc:async()=>({exists:()=>false}),getDocFromServer:async()=>{priceReads++;return {exists:()=>true,data:()=>saved}},
        runTransaction:async(_,fn)=>fn({get:async()=>({exists:()=>false}),set:(p,d)=>writes.push({p,d})}),setDoc:async(p,d)=>writes.push({p,d}),fetchTrades:async()=>[buy(),buy({id:'b2',code:'2317',price:50,total:50000}),buy({id:'future',date:'2099-01-01'})],
        fetchDividends:async()=>[div({date:'2099-01-01'})],fetchCashflow:async()=>[{date:'2026-01-01',type:'in',amount:150000}],
        toLocalDateString:()=>asOf,canRunAutoSnapshot:()=>true,buildPortfolioSnapshot:portfolio.buildPortfolioSnapshot,
        describeSnapshotPriceIssues:policy.describeSnapshotPriceIssues,
        validateSnapshotForWrite:()=>({valid:true}),invalidateAssetSnapshots:()=>{},console:{info:()=>{},error:()=>{}},
    })
    const result=await mod.maybeAutoSnapshotToday({overwrite:true,trigger:'price-update'})
    assert.equal(priceReads,1)
    assert.equal(writes.length,['complete','intraday','reference'].includes(scenario)?1:0)
    if(['complete','intraday','reference'].includes(scenario)){
        assert.equal(result.status,'written');assert.equal(writes[0].d.totalAssets,150000)
        assert.equal(writes[0].d.cash,0)
        if(scenario==='intraday')assert.equal(writes[0].d.valuationQuality,'intraday')
    }else assert.ok(['stale-prices','missing-prices'].includes(result.status))
    if (scenario==='old date') {
        const feedback=mod.formatAutoSnapshotFeedback(result)
        assert.equal(feedback.type,'info')
        assert.match(feedback.message,/來源日期 2026-09-04（2330）/)
        assert.ok(!feedback.message.includes('2317'))
    }
})

function updateCallback(bindings) {
    const source=read('src/PriceContext.tsx')
    const ast=ts.createSourceFile('test.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX)
    let callback
    function visit(node){
        if(ts.isVariableDeclaration(node)&&node.name.getText(ast)==='fetchAndStorePrices')callback=node.initializer.arguments[0]
        ts.forEachChild(node,visit)
    }
    visit(ast)
    assert.ok(callback)
    return compile('export const run = '+callback.getText(ast),bindings).run
}
function priceHarness(getQuotes, failSnapshot = false) {
    const state={saved:{},snapshots:0,writes:0,user:{uid:'a'}}
    const investAuth={currentUser:state.user}
    const cacheRef={current:{}}
    const run=updateCallback({
        investDB:'db',investAuth,cacheRef,requestClock:{current:0},pending:{current:0},setPriceLoading:()=>{},
        captureUserSession:()=>{const initial=investAuth.currentUser;return {doc:()=>initial.uid+'/prices',assertActive:()=>{if(initial!==investAuth.currentUser)throw Error('session changed')}}},
        isFubonSnapshotEnabled:()=>false,
        getSharedQuoteObservations:getQuotes,mergeQuoteObservations:policy.mergeQuoteObservations,
        runTransaction:async(_,fn)=>fn({get:async()=>({exists:()=>true,data:()=>state.saved}),set:(_,d)=>{state.writes++;state.saved=d}}),
        loadCachedPrices:saved=>{cacheRef.current=policy.mergeQuoteObservations(cacheRef.current,saved._quotes)},
        maybeAutoSnapshotToday:async()=>{state.snapshots++;if(failSnapshot)throw Error('snapshot offline');return {status:'stale-prices'}},console:{error:()=>{}},
    })
    return {run:async codes=>(await run(codes)).prices,state,investAuth}
}
test('F11 actual update callback ignores a late response after a newer update',async()=>{
    const pending=[]
    const {run,state}=priceHarness((_,requestedAt)=>new Promise(resolve=>pending.push({resolve,requestedAt})))
    const older=run(['2330']),newer=run(['2330'])
    pending[1].resolve({'2330':obs(120,{requestedAt:pending[1].requestedAt})});await newer
    pending[0].resolve({'2330':obs(100,{requestedAt:pending[0].requestedAt})});const result=await older
    assert.equal(state.saved['2330'],120);assert.equal(result['2330'],120)
})
test('F11 account switch while fetching prevents persistence and snapshot',async()=>{
    let resolve
    const harness=priceHarness(()=>new Promise(r=>{resolve=r}))
    const pending=harness.run(['2330'])
    harness.investAuth.currentUser={uid:'b'}
    resolve({'2330':obs(100)})
    await assert.rejects(pending,/session changed/)
    assert.equal(harness.state.writes,0);assert.equal(harness.state.snapshots,0)
})

test('successful committed quotes remain available when the optional snapshot fails',async()=>{
    const {run,state}=priceHarness(async(_,requestedAt)=>({'2330':obs(120,{requestedAt})}),true)
    assert.equal((await run(['2330']))['2330'],120)
    assert.equal(state.saved['2330'],120)
    assert.equal(state.snapshots,1)
})
test('F11 quote fetch retains source provenance and identifies reference-only fallback',async()=>{
    const mod=compile(read('src/lib/fugle.ts').replace('import.meta.env.VITE_FUGLE_API_KEY',"'fixture'"),{
        ...compile(read('src/lib/quoteTiming.ts')),
        ...policy,captureUserSession:()=>({assertActive(){}}), authenticatedFetch:async(_,__,options)=>({ok:true,json:async()=>JSON.parse(options.body).symbol==='2330'?{date:asOf,closePrice:100,lastUpdated:123}:{date:asOf,referencePrice:50}})
    })
    const quotes=await mod.getMultipleQuoteObservations(['2330','2317'],'2026-09-07T01:00:00Z')
    assert.equal(quotes['2330'].sourceUpdatedAt,123)
    assert.equal(quotes['2330'].sourceDate,asOf)
    assert.equal(quotes['2317'].priceType,'reference')
})
test('F12 new confirmed dividend requires valid independent payment dates; old rows remain compatible',()=>{
    const mod=compile(read('src/lib/investmentValidation.ts'),calc)
    assert.equal(mod.validateDividendForWrite(div({status:'confirmed'})).valid,false)
    assert.equal(mod.validateDividendForWrite(div({status:'confirmed',cashPaymentDate:asOf,stockDistributionDate:'2026-09-09'})).valid,true)
    assert.equal(mod.validateDividendForWrite(div({cashPaymentDate:'2026-02-30'})).valid,false)
    assert.equal(mod.validateDividendForWrite(div()).valid,true)
})

test('F12 explicit distribution is available for selling on the distribution day',()=>{
    const sell=buy({id:'sell',date:asOf,type:'sell',shares:1100,total:110000})
    const dividends=[div({date:'2026-08-01',cashDividend:0,stockDistributionDate:asOf})]
    assert.equal(calc.calcSharesBeforeTrade(sell,[buy()],dividends),1100)
    const result=balance({trades:[buy(),sell],dividends})
    assert.equal(result.holdings.length,0);assert.equal(result.realizedPnL,10000)
})
