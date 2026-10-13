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



const returns=compile(read('src/lib/performanceReturns.ts'))
test('after-close deposit reconciles an earlier snapshot without inventing a loss or double counting',()=>{
    const original=[{date:'2026-09-10',totalAssets:1000000,cash:0,cashflowBasis:'after-close-v1',cashflowNetAtCapture:1000000},
        {date:'2026-09-11',totalAssets:1010000,cash:-200000,cashflowBasis:'after-close-v1',cashflowNetAtCapture:1000000}]
    const flows=[{date:'2026-09-01',amount:1000000},{date:'2026-09-11',amount:200000}]
    const aligned=returns.alignSnapshotCashflows(original,flows)
    assert.equal(aligned[1].cash,0);assert.equal(aligned[1].totalAssets,1210000)
    assert.equal(returns.buildTimeWeightedReturns(aligned,flows,true)[1].assetReturn,1)
    assert.deepEqual(returns.alignSnapshotCashflows(aligned,flows),aligned)
    assert.equal(original[1].totalAssets,1010000)
})
test('cash-flow edits, deletions and withdrawals adjust only eligible dates, preserving legacy snapshots',()=>{
    const base={date:'2026-09-11',cash:100,totalAssets:1100,cashflowBasis:'after-close-v1',cashflowNetAtCapture:200}
    assert.equal(returns.alignSnapshotCashflows([base],[{date:'2026-09-11',amount:250}])[0].totalAssets,1150)
    assert.equal(returns.alignSnapshotCashflows([base],[])[0].totalAssets,900)
    assert.equal(returns.alignSnapshotCashflows([base],[{date:'2026-09-11',amount:-50}])[0].totalAssets,850)
    assert.equal(returns.alignSnapshotCashflows([base],[{date:'2026-09-12',amount:250}])[0].totalAssets,900)
    const legacy={date:'2026-09-11',cash:100,totalAssets:1100}
    assert.deepEqual(returns.alignSnapshotCashflows([legacy],[]),[legacy])
    assert.throws(()=>returns.alignSnapshotCashflows([base],[{date:'invalid',amount:5}]))
})
test('after-close default requires valuations on intermediate cash-flow days, including offsetting flows',()=>{
    const values=[{date:'2026-09-09',totalAssets:100},{date:'2026-09-11',totalAssets:110}]
    const result=returns.buildTimeWeightedReturns(values,[{date:'2026-09-10',amount:20},{date:'2026-09-10',amount:-20}],true)
    assert.equal(result[1].assetReturn,null);assert.match(result[1].issue,/缺少快照/)
    assert.equal(returns.buildTimeWeightedReturns(values,[],true)[1].assetReturn,10)
})
const calc=compile(read('src/lib/calc.ts'))
const dates=compile(read('src/lib/date.ts'))
const policy=compile(read('src/lib/pricePolicy.ts'),dates)
const portfolio=compile(read('src/lib/portfolioSnapshot.ts'),{...calc,...dates,...policy})
test('today snapshot records exactly the dated cash flows used in its valuation',async()=>{
    const flows=[{date:'2026-09-10',type:'in',amount:1000},{date:'2026-09-11',type:'out',amount:100},{date:'2026-09-12',type:'in',amount:500}]
    const mod=compile(read('src/lib/snapshot.ts'),{
        captureUserSession:()=>({doc:()=>'',assertActive:()=>{}}),investDB:'fixture',toLocalDateString:()=> '2026-09-11',
        fetchTrades:async()=>[],fetchDividends:async()=>[],fetchCashflow:async()=>flows,
        getDocFromServer:async()=>({exists:()=>false}),isAfterTaiwanClose:()=>true,...portfolio,
    })
    const {snapshot}=await mod.buildTodaySnapshot()
    assert.equal(snapshot.cash,900);assert.equal(snapshot.totalAssets,900)
    assert.equal(snapshot.cashflowBasis,'after-close-v1');assert.equal(snapshot.cashflowNetAtCapture,900)
})
const startDate='2025-01-01',endDate='2026-01-01'
const result=(overrides={})=>returns.calculateAccountReturn({startDate,endDate,startValue:100000,endValue:110000,cashflows:[],...overrides})
const near=(actual,expected)=>assert.ok(Math.abs(actual-expected)<0.00001,`${actual} != ${expected}`)
const buy={id:'b',date:'2024-12-31',code:'2330',name:'fixture',type:'buy',price:100,shares:1000,fee:0,tax:0,total:100000}

for(const fraction of [0,0.5,1])test('F04 account NAV retains proceeds, sold fraction '+fraction,()=>{
    const trades=[buy]
    if(fraction)trades.push({...buy,id:'s',date:'2025-06-01',type:'sell',price:110,shares:1000*fraction,total:110000*fraction})
    const ending=portfolio.buildPortfolioSnapshot({asOf:endDate,trades,dividends:[],cashflow:[{date:buy.date,type:'in',amount:100000}],savedPrices:{2330:110}})
    near(ending.netAssets,110000)
    near(result({endValue:ending.netAssets}).annualized,10)
    near(ending.cash,110000*fraction)
})
test('F04 withdrawing principal is an external inflow, not a loss',()=>{
    near(result({endValue:0,cashflows:[{date:endDate,amount:110000}]}).annualized,10)
})
test('F04 deposits do not inflate returns and boundary flows are counted once',()=>{
    near(result({endValue:200000,cashflows:[{date:startDate,amount:-100000},{date:'2025-06-01',amount:-100000},{date:'2026-02-01',amount:500000}]}).annualized,0)
})
test('F04 end-day withdrawal and ending cash together retain complete value',()=>{
    near(result({endValue:50000,cashflows:[{date:endDate,amount:60000}]}).annualized,10)
})
test('F04 margin account uses net equity and interest is already in cash',()=>{
    const trades=[{...buy,isMargin:true,marginAmount:60000,total:40000},
        {...buy,id:'s',date:'2025-06-01',type:'sell',price:110,isMargin:true,marginPrincipal:60000,marginInterest:100,marginRepay:60100,total:49900}]
    const ending=portfolio.buildPortfolioSnapshot({asOf:endDate,trades,dividends:[],cashflow:[{date:buy.date,type:'in',amount:40000}],savedPrices:{}})
    assert.equal(ending.marginDebt,0);assert.equal(ending.netAssets,49900)
    near(result({startValue:40000,endValue:ending.netAssets}).annualized,24.75)
})
test('F04 dividends already contained in ending cash are not added twice',()=>{
    const ending=portfolio.buildPortfolioSnapshot({asOf:endDate,trades:[buy],dividends:[{date:'2025-06-01',code:'2330',name:'fixture',cashDividend:5000,stockDividend:0}],cashflow:[{date:buy.date,type:'in',amount:100000}],savedPrices:{2330:100}})
    near(result({endValue:ending.netAssets}).annualized,5)
})
test('F04 total loss remains -100%, negative NAV and missing valuation are not 0%',()=>{
    assert.equal(result({endValue:0}).annualized,-100)
    assert.equal(result({endValue:-1000}).annualized,null)
    assert.equal(result({startValue:undefined}).annualized,null)
    assert.match(result({endValue:undefined}).reason,/缺少/)
})
test('F04 valid zero opening balance can begin with a later investment',()=>{
    near(result({startValue:0,endValue:100000,cashflows:[{date:'2025-06-01',amount:-100000}]}).annualized,0)
})
test('F04 zero capital, invalid dates and multiple detected XIRRs are unavailable',()=>{
    assert.equal(result({startValue:0,endValue:0}).annualized,null)
    assert.equal(result({startDate:'2025-02-30'}).annualized,null)
    assert.equal(returns.accountXirr([{date:'2025-01-01',amount:-100},{date:'2026-01-01',amount:230},{date:'2027-01-01',amount:-132}]),null)
})
const curve=(values,flows=[])=>returns.buildTimeWeightedReturns(values.map((totalAssets,i)=>({date:`2026-01-0${i+1}`,totalAssets})),flows)
test('F09 complete loss is -100%, not a flat zero return',()=>{
    assert.deepEqual(curve([100000,0,0]).map(p=>p.assetReturn),[0,-100,-100])
})
test('F09 prior profits still end at -100% when all assets are lost',()=>{
    assert.deepEqual(curve([100,110,0]).map(p=>p.assetReturn),[0,10,-100])
})
test('F09 pure withdrawal to zero preserves return and is not a total loss',()=>{
    assert.deepEqual(curve([100000,0,0],[{date:'2026-01-02',amount:-100000}]).map(p=>p.assetReturn),[0,0,0])
})
test('F09 negative NAV breaks the series instead of hiding the loss',()=>{
    const points=curve([100000,-10000,10000])
    assert.deepEqual(points.map(p=>p.assetReturn),[0,null,null])
    assert.match(points[1].issue,/負/)
})
test('F09 reinvestment after zero requires a new positive baseline',()=>{
    const points=curve([100000,0,50000,55000],[{date:'2026-01-03',amount:50000}])
    assert.deepEqual(points.map(p=>p.assetReturn),[0,-100,null,null])
    assert.deepEqual(curve([50000,55000]).map(p=>p.assetReturn),[0,10])
})
test('F09 zero initial value and inconsistent flow timing do not manufacture returns',()=>{
    assert.deepEqual(curve([0,100]).map(p=>p.assetReturn),[null,null])
    assert.equal(curve([100,50],[{date:'2026-01-02',amount:100}])[1].assetReturn,null)
})
test('F09 ordinary gains and deposits retain existing endpoint-flow approximation',()=>{
    assert.deepEqual(curve([100,220,242],[{date:'2026-01-02',amount:100}]).map(p=>p.assetReturn),[0,20,32])
})
function callback(path,name,bindings){
    const source=read(path),ast=ts.createSourceFile(path,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX)
    let node
    const visit=n=>{if(ts.isVariableDeclaration(n)&&n.name.getText(ast)===name)node=n.initializer.arguments[0];ts.forEachChild(n,visit)}
    visit(ast);assert.ok(node,name)
    return compile('export const run = '+node.getText(ast),bindings).run
}
function customHarness({snapshots=[{date:startDate,totalAssets:100000},{date:endDate,totalAssets:110000}],config={},today='2026-09-08',current,flows=[]}={}){
    const state={rate:null,message:'',basis:'',loading:false,liveReads:0}
    const run=callback('src/pages/invest/YearReview.tsx','calcCustomCAGR',{
        ...returns,customStart:startDate,customEnd:endDate,customRequestRef:{current:0},investDB:'db',
        setCustomCAGR:v=>{state.rate=v},setCustomMessage:v=>{state.message=v},setCustomBasis:v=>{state.basis=v},setPerfLoading:v=>{state.loading=v},
        captureUserSession:()=>({doc:()=>'',assertActive:()=>{}}),fetchAssetSnapshots:async()=>snapshots,fetchCashflow:async()=>flows,
        getDoc:async()=>({exists:()=>true,data:()=>config}),toLocalDateString:()=>today,
        buildTodaySnapshot:async()=>{state.liveReads++;return current},
    })
    return {state,run}
}
test('F04 real UI callback uses full account snapshots, including sale proceeds',async()=>{
    const {state,run}=customHarness();await run();near(state.rate,10);assert.match(state.basis,/110,000/);assert.equal(state.loading,false)
})
test('F04 historical missing endpoints never use current prices',async()=>{
    const {state,run}=customHarness({snapshots:[{date:startDate,totalAssets:100000}]});await run()
    assert.equal(state.rate,null);assert.match(state.message,/缺少/);assert.equal(state.liveReads,0)
})

test('daily trend preference uses legacy/intraday UI endpoints without changing saved quality',async()=>{
    const snapshots=[{date:startDate,totalAssets:100000,valuationQuality:'intraday'},{date:endDate,totalAssets:110000}]
    const before=structuredClone(snapshots),{state,run}=customHarness({snapshots})
    await run();near(state.rate,10);assert.match(state.basis,/當日資產快照/)
    assert.ok(!state.basis.includes('收盤'));assert.deepEqual(snapshots,before)
})
test('F04 today fallback uses complete account snapshot, and rejects stale prices',async()=>{
    for(const stale of [[],['2330']]){
        const {state,run}=customHarness({snapshots:[{date:startDate,totalAssets:100000}],config:{startDate,startValue:100000},today:endDate,current:{snapshot:{date:endDate,totalAssets:110000,valuationQuality:'closing'},missing:[],stale}})
        await run();assert.equal(state.liveReads,1)
        if(stale.length)assert.equal(state.rate,null);else near(state.rate,10)
    }
})
test('F09 actual chart keeps benchmark visible when the asset series is undefined',()=>{
    const points=callback('src/pages/invest/AssetTrend.tsx','returnChartData',{
        activeReturnPoints:returns.buildTimeWeightedReturns([{date:'2026-01-01',totalAssets:100},{date:'2026-01-02',totalAssets:-10}],[],true),taiexData:{'2026-01-01':100,'2026-01-02':105},
    })()
    assert.equal(points[1].assetReturn,null);assert.equal(points[1].taiexReturn,5)
})

const valuations = entries => entries.map(([date,totalAssets])=>({date,totalAssets}))
test('restart skips a missing flow-day valuation, keeps original snapshots, and does not subtract opening flows twice',()=>{
    const snapshots=valuations([['2026-01-01',100],['2026-01-09',200],['2026-01-10',270]])
    const flows=[{date:'2026-01-05',amount:50},{date:'2026-01-09',amount:50},{date:'2026-01-10',amount:50}]
    const before=structuredClone({snapshots,flows})
    const original=returns.buildTimeWeightedReturns(snapshots,flows,true)
    assert.equal(original[1].assetReturn,null)
    const result=returns.buildRestartedTimeWeightedReturns(snapshots,flows)
    assert.equal(result.startDate,'2026-01-09')
    assert.equal(result.skippedSnapshots,1)
    assert.deepEqual(result.points.map(p=>p.assetReturn),[0,10])
    assert.deepEqual({snapshots,flows},before)
    assert.deepEqual(returns.buildTimeWeightedReturns(snapshots,flows,true),original)
})

test('restart finds a suffix through the latest date even when there are several missing flow days',()=>{
    const snapshots=valuations([['2026-01-01',100],['2026-01-03',150],['2026-01-04',165],['2026-01-08',200],['2026-01-10',220]])
    const flows=[{date:'2026-01-02',amount:50},{date:'2026-01-06',amount:35}]
    const result=returns.buildRestartedTimeWeightedReturns([...snapshots].reverse(),flows)
    assert.equal(result.startDate,'2026-01-08')
    assert.equal(result.skippedSnapshots,3)
    assert.deepEqual(result.points.map(p=>p.assetReturn),[0,10])
    const shorter=returns.buildRestartedTimeWeightedReturns(snapshots.slice(3),flows)
    assert.deepEqual(shorter.points,result.points)
    assert.equal(shorter.skippedSnapshots,0)
})

test('restart preserves a valid complete loss and uses a new positive baseline only after an actual broken interval',()=>{
    const loss=valuations([['2026-01-01',100],['2026-01-02',0],['2026-01-03',0]])
    assert.deepEqual(returns.buildRestartedTimeWeightedReturns(loss,[]).points.map(p=>p.assetReturn),[0,-100,-100])
    const reinvest=[...loss,{date:'2026-01-04',totalAssets:50},{date:'2026-01-05',totalAssets:55}]
    const result=returns.buildRestartedTimeWeightedReturns(reinvest,[{date:'2026-01-04',amount:50}])
    assert.equal(result.startDate,'2026-01-04')
    assert.deepEqual(result.points.map(p=>p.assetReturn),[0,10])
})

test('restart does not offer an isolated baseline, a stale earlier segment, or a fabricated zero return',()=>{
    for(const entries of [[],[['2026-01-01',100]],[['2026-01-01',100],['2026-01-02',-10]],[['2026-01-01',-10],['2026-01-02',100]],[['2026-01-01',100],['2026-01-02',NaN]]]) {
        const result=returns.buildRestartedTimeWeightedReturns(valuations(entries),[])
        assert.equal(result.startDate,null)
        assert.deepEqual(result.points,[])
        assert.ok(result.unavailableReason)
    }
    const result=returns.buildRestartedTimeWeightedReturns(valuations([['2026-01-01',100],['2026-01-03',150]]),[{date:'2026-01-02',amount:50}])
    assert.equal(result.startDate,null)
})

test('restart rejects invalid dates, duplicate snapshot dates and unknown flow amounts',()=>{
    assert.equal(returns.buildRestartedTimeWeightedReturns(valuations([['2026-02-30',100],['2026-03-01',110]]),[]).startDate,null)
    assert.match(returns.buildRestartedTimeWeightedReturns(valuations([['2026-01-01',100],['2026-01-01',110]]),[]).unavailableReason,/重複/)
    assert.equal(returns.buildRestartedTimeWeightedReturns(valuations([['2026-01-01',100],['2026-01-02',110]]),[{date:'2026-01-02',amount:NaN}]).startDate,null)
})

test('actual restarted chart rebases both asset and benchmark on the same date and same period',()=>{
    const activeReturnPoints=returns.buildRestartedTimeWeightedReturns(valuations([['2026-01-01',100],['2026-01-09',150],['2026-01-10',165]]),[{date:'2026-01-05',amount:50}]).points
    const points=callback('src/pages/invest/AssetTrend.tsx','returnChartData',{
        activeReturnPoints,taiexData:{'2026-01-01':100,'2026-01-08':200,'2026-01-10':210},
    })()
    assert.deepEqual(points.map(p=>p.date),['2026-01-09','2026-01-10'])
    assert.deepEqual(points.map(p=>[p.assetReturn,p.taiexReturn]),[[0,0],[10,5]])
})

test('restarted comparison never substitutes a future benchmark quote for a missing common baseline',()=>{
    const points=callback('src/pages/invest/AssetTrend.tsx','returnChartData',{
        activeReturnPoints:[{date:'2026-01-09',assetReturn:0,issue:null},{date:'2026-01-10',assetReturn:10,issue:null}],taiexData:{'2026-01-10':210},
    })()
    assert.deepEqual(points.map(p=>p.taiexReturn),[null,null])
    assert.deepEqual(callback('src/pages/invest/AssetTrend.tsx','returnChartData',{activeReturnPoints:[],taiexData:{}})(),[])
})
