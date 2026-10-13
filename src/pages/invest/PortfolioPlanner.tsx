import { useEffect, useMemo, useState } from 'react'
import DisclosureNote from '../../components/DisclosureNote'
import { getDoc } from 'firebase/firestore'
import { AlertTriangle, Calculator, Plus, RefreshCw, RotateCcw, Save, Scale, ShieldAlert, Trash2, WandSparkles } from 'lucide-react'
import { calcPortfolioRebalance, calcPortfolioRisk } from '../../lib/calc'
import { loadPortfolioSnapshot } from '../../lib/portfolioSnapshot'
import { usePrices } from '../../PriceContext'
import { card, inp, lbl } from '../../ui/styles'
import { useInvestSync } from '../../InvestSyncContext'
import { investDB } from '../../lib/firebase'
import { captureUserSession, userDocNested } from '../../lib/userDB'

interface PlannerRow {
    id: string
    code: string
    name: string
    currentShares: number
    currentMarketValue: number
    price: string
    targetWeight: string
    priceFallback: boolean
}

interface SavedScenario {
    id: string
    name: string
    targetPosition: string
    mode: 'full' | 'buy-only' | 'sell-only'
    lotSize: 1 | 1000
    includeFees: boolean
    risk?: {
        maxWeight: string
        maxGroupWeight: string
        minCashPct: string
        maxMarginPct: string
        minEtfWeightPct: string
        stressDropPct: string
        maxStressLoss: string
    }
    rows: Array<Pick<PlannerRow, 'code' | 'name' | 'price' | 'targetWeight'>>
}

const LEGACY_SCENARIO_STORAGE_KEY = 'invest:portfolio-planner:scenarios:v1'
const money = (value: number) => `$${Math.round(value).toLocaleString('zh-TW')}`
const percent = (value: number) => `${value.toFixed(1)}%`

export default function PortfolioPlanner() {
    const { prices, priceLoading, updatePrices, loadCachedPrices } = usePrices()
    const { version: syncVersion } = useInvestSync()
    const [rows, setRows] = useState<PlannerRow[]>([])
    const [loading, setLoading] = useState(true)
    const [hasLoaded, setHasLoaded] = useState(false)
    const [error, setError] = useState('')
    const [targetPosition, setTargetPosition] = useState('')
    const [cash, setCash] = useState(0)
    const [equity, setEquity] = useState(0)
    const [marketValue, setMarketValue] = useState(0)
    const [newCode, setNewCode] = useState('')
    const [newName, setNewName] = useState('')
    const [newPrice, setNewPrice] = useState('')
    const [mode, setMode] = useState<'full' | 'buy-only' | 'sell-only'>('full')
    const [lotSize, setLotSize] = useState<1 | 1000>(1)
    const [includeFees, setIncludeFees] = useState(true)
    const [maxWeight, setMaxWeight] = useState('25')
    const [maxGroupWeight, setMaxGroupWeight] = useState('40')
    const [minCashPct, setMinCashPct] = useState('10')
    const [maxMarginPct, setMaxMarginPct] = useState('50')
    const [minEtfWeightPct, setMinEtfWeightPct] = useState('0')
    const [stressDropPct, setStressDropPct] = useState('20')
    const [maxStressLoss, setMaxStressLoss] = useState('0')
    const [marginDebt, setMarginDebt] = useState(0)
    const [stockGroups, setStockGroups] = useState<Record<string, string>>({})
    const [scenarioName, setScenarioName] = useState('')
    const [scenarioSession] = useState(() => captureUserSession())
    const scenarioStorageKey = `invest:portfolio-planner:scenarios:v2:${encodeURIComponent(scenarioSession.uid)}`
    const [hasLegacyScenarios, setHasLegacyScenarios] = useState(false)
    const [savedScenarios, setSavedScenarios] = useState<SavedScenario[]>([])

    const load = async (preservePlan = false) => {
        setLoading(true)
        setError('')
        try {
            const [snapshot, groupDoc] = await Promise.all([
                loadPortfolioSnapshot(prices),
                getDoc(userDocNested(investDB, 'settings', 'stockGroups')),
            ])
            loadCachedPrices(snapshot.savedPriceData, snapshot.priceUpdatedAt)
            const nextRows = snapshot.holdings.map(holding => ({
                id: holding.code,
                code: holding.code,
                name: holding.name,
                currentShares: holding.shares,
                currentMarketValue: holding.marketValue,
                price: String(holding.currentPrice ?? holding.avgCost),
                targetWeight: holding.ratio.toFixed(1),
                priceFallback: holding.priceSource === 'cost',
            }))
            setRows(current => {
                if (!preservePlan) return nextRows
                const nextByCode = new Map(nextRows.map(row => [row.code, row]))
                const refreshed = current.map(row => {
                    const latest = nextByCode.get(row.code)
                    if (!latest) return row.currentShares > 0 ? { ...row, currentShares: 0, currentMarketValue: 0 } : row
                    nextByCode.delete(row.code)
                    return { ...latest, targetWeight: row.targetWeight, price: latest.priceFallback ? row.price : latest.price }
                })
                return [...refreshed, ...nextByCode.values()]
            })
            setCash(snapshot.cash)
            setHasLoaded(true)
            setMarketValue(snapshot.marketValue)
            setEquity(snapshot.equityCapital)
            setMarginDebt(snapshot.marginDebt)
            setStockGroups(groupDoc.exists() ? groupDoc.data() as Record<string, string> : {})
            if (!preservePlan) setTargetPosition(snapshot.positionPct?.toFixed(1) ?? '0')
        } catch (err) {
            console.error(err)
            setError('組合資料載入失敗，請確認網路連線後再試一次。')
        } finally {
            setLoading(false)
        }
    }

    useEffect(() => {
        try {
            scenarioSession.assertActive()
            setHasLegacyScenarios(localStorage.getItem(LEGACY_SCENARIO_STORAGE_KEY) !== null)
            const saved = JSON.parse(localStorage.getItem(scenarioStorageKey) ?? '[]')
            if (Array.isArray(saved)) setSavedScenarios(saved)
        } catch { /* 忽略損壞的本機草稿 */ }
        void load(syncVersion > 0)
        // 首次載入即可；各核心集合由共用快取保持同一版本。
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [syncVersion])

    const result = useMemo(() => calcPortfolioRebalance(
        equity,
        Number(targetPosition),
        rows.map(row => ({
            code: row.code,
            name: row.name,
            currentMarketValue: row.currentMarketValue,
            currentShares: row.currentShares,
            price: Number(row.price) > 0 ? Number(row.price) : null,
            targetWeightPct: Number(row.targetWeight),
        })),
        { mode, lotSize, includeFees },
    ), [equity, includeFees, lotSize, mode, rows, targetPosition])

    const updateRow = (id: string, patch: Partial<PlannerRow>) => {
        setRows(current => current.map(row => row.id === id ? { ...row, ...patch } : row))
    }

    const addStock = () => {
        const code = newCode.trim().toUpperCase().replace('.TW', '')
        if (!code || rows.some(row => row.code === code)) return
        setRows(current => [...current, {
            id: `${code}-${Date.now()}`,
            code,
            name: newName.trim(),
            currentShares: 0,
            currentMarketValue: 0,
            price: newPrice,
            targetWeight: '0',
            priceFallback: false,
        }])
        setNewCode('')
        setNewName('')
        setNewPrice('')
    }

    const normalizeWeights = () => {
        const total = rows.reduce((sum, row) => sum + Math.max(0, Number(row.targetWeight) || 0), 0)
        if (total <= 0) return
        setRows(current => current.map(row => ({
            ...row,
            targetWeight: (Math.max(0, Number(row.targetWeight) || 0) / total * 100).toFixed(1),
        })))
    }

    const setEqualWeights = () => {
        if (rows.length === 0) return
        const weight = 100 / rows.length
        setRows(current => current.map((row, index) => ({
            ...row,
            targetWeight: index === current.length - 1
                ? (100 - Number((weight * (current.length - 1)).toFixed(1))).toFixed(1)
                : weight.toFixed(1),
        })))
    }

    const persistScenarios = (next: SavedScenario[]) => {
        try {
            scenarioSession.assertActive()
            localStorage.setItem(scenarioStorageKey, JSON.stringify(next))
            setSavedScenarios(next)
            return true
        } catch {
            setError('方案未儲存：請確認登入帳號與瀏覽器儲存空間後重試。')
            return false
        }
    }

    const saveScenario = () => {
        const name = scenarioName.trim() || `方案 ${savedScenarios.length + 1}`
        const scenario: SavedScenario = {
            id: `${Date.now()}`,
            name,
            targetPosition,
            mode,
            lotSize,
            includeFees,
            risk: { maxWeight, maxGroupWeight, minCashPct, maxMarginPct, minEtfWeightPct, stressDropPct, maxStressLoss },
            rows: rows.map(({ code, name: stockName, price, targetWeight }) => ({ code, name: stockName, price, targetWeight })),
        }
        if (persistScenarios([...savedScenarios, scenario])) setScenarioName('')
    }

    const applyScenario = (scenario: SavedScenario) => {
        const currentByCode = new Map(rows.map(row => [row.code, row]))
        const scenarioCodes = new Set(scenario.rows.map(row => row.code))
        const restored = scenario.rows.map(saved => {
            const current = currentByCode.get(saved.code)
            return current
                ? { ...current, name: saved.name || current.name, price: saved.price || current.price, targetWeight: saved.targetWeight }
                : {
                    id: `${saved.code}-${Date.now()}`,
                    code: saved.code,
                    name: saved.name,
                    currentShares: 0,
                    currentMarketValue: 0,
                    price: saved.price,
                    targetWeight: saved.targetWeight,
                    priceFallback: false,
                }
        })
        const newlyHeld = rows
            .filter(row => row.currentShares > 0 && !scenarioCodes.has(row.code))
            .map(row => ({ ...row, targetWeight: '0' }))
        setRows([...restored, ...newlyHeld])
        setTargetPosition(scenario.targetPosition)
        setMode(scenario.mode)
        setLotSize(scenario.lotSize)
        setIncludeFees(scenario.includeFees)
        if (scenario.risk) {
            setMaxWeight(scenario.risk.maxWeight)
            setMaxGroupWeight(scenario.risk.maxGroupWeight)
            setMinCashPct(scenario.risk.minCashPct)
            setMaxMarginPct(scenario.risk.maxMarginPct)
            setMinEtfWeightPct(scenario.risk.minEtfWeightPct)
            setStressDropPct(scenario.risk.stressDropPct)
            setMaxStressLoss(scenario.risk.maxStressLoss)
        }
    }

    const resetToCurrent = () => {
        const total = rows.reduce((sum, row) => sum + row.currentMarketValue, 0)
        setRows(current => current.map(row => ({
            ...row,
            targetWeight: total > 0 ? (row.currentMarketValue / total * 100).toFixed(1) : '0',
        })))
        setTargetPosition(equity > 0 ? (marketValue / equity * 100).toFixed(1) : '0')
    }

    const refreshPrices = async () => {
        const codes = rows.map(row => row.code).filter(Boolean)
        const quotes = await updatePrices(codes)
        const marginDebt = marketValue + cash - equity
        const updatedMarketValue = rows.reduce((sum, row) => {
            const nextPrice = quotes[row.code]
            return sum + row.currentShares * (typeof nextPrice === 'number' && nextPrice > 0 ? nextPrice : Number(row.price) || 0)
        }, 0)
        setRows(current => current.map(row => {
            const nextPrice = quotes[row.code]
            if (typeof nextPrice !== 'number' || nextPrice <= 0) return row
            return {
                ...row,
                price: String(nextPrice),
                priceFallback: false,
                currentMarketValue: row.currentShares * nextPrice,
            }
        }))
        setMarketValue(updatedMarketValue)
        setEquity(updatedMarketValue + cash - marginDebt)
    }

    const remainingCash = result ? cash - result.netCashRequired : cash
    const weightOff = result ? Math.abs(result.allocatedWeightPct - 100) > 0.05 : false
    const sellsTooManyShares = result?.rows.some(row => row.limitedByHoldings) ?? false
    const maxWeightNum = Number(maxWeight)
    const risk = useMemo(() => calcPortfolioRisk(
        result?.rows.map(row => ({
            code: row.code,
            group: stockGroups[row.code],
            projectedMarketValue: row.projectedMarketValue,
        })) ?? [],
        remainingCash,
        marginDebt,
        Number(stressDropPct),
        {
            maxSingleWeightPct: maxWeightNum,
            maxGroupWeightPct: Number(maxGroupWeight),
            minCashPct: Number(minCashPct),
            maxMarginPct: Number(maxMarginPct),
            minEtfWeightPct: Number(minEtfWeightPct),
            maxStressLoss: Number(maxStressLoss),
        },
    ), [marginDebt, maxGroupWeight, maxMarginPct, maxStressLoss, maxWeightNum, minCashPct, minEtfWeightPct, remainingCash, result, stockGroups, stressDropPct])

    return (
        <div className="portfolio-planner-page">
            <style>{`
                .portfolio-planner-page { padding: var(--ui-page-padding, clamp(16px, 3vw, 32px)); max-width: 1600px; margin: 0 auto; }
                .planner-summary { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 16px; margin-bottom: 20px; }
                .planner-kpi { min-height: 112px; display: flex; flex-direction: column; justify-content: space-between; }
                .planner-kpi-label { color: var(--c-muted); font-size: 13px; }
                .planner-kpi-value { margin-top: 8px; color: var(--c-text); font-size: clamp(19px, 2vw, 24px); font-weight: 700; letter-spacing: -0.02em; }
                .planner-kpi-note { margin-top: 6px; color: var(--c-muted); font-size: 11px; line-height: 1.45; }
                .planner-workspace { display: grid; grid-template-columns: minmax(0, 1.35fr) minmax(340px, .65fr); gap: 16px; margin-bottom: 16px; }
                .planner-section-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 18px; }
                .planner-section-title { display: flex; align-items: center; gap: 9px; color: var(--c-text); font-size: 14px; font-weight: 650; }
                .planner-section-copy { margin: 4px 0 0 27px; color: var(--c-muted); font-size: 11px; line-height: 1.5; }
                .planner-position-grid { display: grid; grid-template-columns: minmax(180px, .75fr) minmax(0, 1.25fr); gap: 24px; align-items: center; }
                .planner-position-input { position: relative; }
                .planner-position-input input { padding-right: 42px !important; font-size: 24px !important; font-weight: 700; min-height: 52px; }
                .planner-position-input span { position: absolute; top: 50%; right: 14px; transform: translateY(-50%); color: var(--c-muted); font-size: 14px; font-weight: 600; }
                .planner-waterline { display: grid; gap: 13px; }
                .planner-waterline-row { display: grid; grid-template-columns: 68px minmax(0, 1fr) 52px; gap: 10px; align-items: center; color: var(--c-muted); font-size: 11px; }
                .planner-waterline-track { height: 8px; overflow: hidden; border-radius: 999px; background: var(--c-bg); }
                .planner-waterline-fill { height: 100%; border-radius: inherit; transition: width 180ms ease; }
                .planner-option-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; margin-top: 18px; padding-top: 18px; border-top: 1px solid var(--c-border); }
                .planner-add-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
                .planner-add-grid .planner-code-field { grid-column: 1 / -1; }
                .planner-add-action { width: 100%; margin-top: 12px; }
                .planner-scenarios { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-top: 18px; padding-top: 18px; border-top: 1px solid var(--c-border); }
                .planner-scenario-chip { display: inline-flex; overflow: hidden; border: 1px solid var(--c-border); border-radius: 8px; background: var(--c-bg); }
                .planner-scenario-chip button { min-height: 34px; border: 0; border-radius: 0; }
                .planner-risk-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
                .planner-risk-summary { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 8px; margin-top: 16px; padding-top: 16px; border-top: 1px solid var(--c-border); }
                .planner-risk-stat { min-width: 0; padding: 11px 12px; border-radius: 8px; background: var(--c-bg); }
                .planner-table-wrap { overflow-x: auto; }
                .planner-table { width: 100%; border-collapse: collapse; min-width: 980px; font-size: 13px; }
                .planner-table th { padding: 11px 12px; border-bottom: 1px solid var(--c-border); color: var(--c-muted); font-size: 12px; font-weight: 500; text-align: left; white-space: nowrap; }
                .planner-table td { padding: 13px 12px; border-bottom: 1px solid var(--c-border); color: var(--c-text); vertical-align: middle; }
                .planner-table tbody tr:hover td { background: color-mix(in srgb, var(--c-accent) 4%, transparent); }
                .planner-mini-input { width: 96px; padding: 8px 9px; box-sizing: border-box; border: 1px solid var(--c-border); border-radius: 8px; outline: none; background: var(--c-bg); color: var(--c-text); }
                .planner-mini-input:focus { border-color: var(--c-accent); }
                .planner-table-footer { display: flex; justify-content: flex-end; gap: 24px; flex-wrap: wrap; margin-top: 16px; padding-top: 14px; border-top: 1px solid var(--c-border); color: var(--c-muted); font-size: 12px; }
                .planner-disclaimer { margin: 12px 2px 0; color: var(--c-muted); font-size: 11px; line-height: 1.6; }
                @media (max-width: 1120px) { .planner-workspace { grid-template-columns: 1fr; } .planner-risk-summary { grid-template-columns: repeat(3, 1fr); } }
                @media (max-width: 900px) { .planner-summary { grid-template-columns: repeat(2, 1fr); } .planner-position-grid { grid-template-columns: 1fr; } }
                @media (max-width: 640px) {
                    .planner-summary, .planner-option-grid, .planner-risk-grid, .planner-risk-summary { grid-template-columns: 1fr; }
                    .planner-kpi { min-height: 96px; }
                    .planner-add-grid { grid-template-columns: 1fr; }
                    .planner-add-grid .planner-code-field { grid-column: auto; }
                    .planner-waterline-row { grid-template-columns: 56px minmax(0, 1fr) 48px; }
                    .planner-section-head { align-items: flex-start; flex-direction: column; }
                    .planner-table-footer { justify-content: flex-start; gap: 10px 18px; }
                }
            `}</style>

            <div className="page-header">
                <div className="page-heading">
                    <h1 className="page-title">組合水位試算</h1>
                    
                </div>
                <div className="page-actions">
                    <button className="ui-button ui-button-secondary" onClick={resetToCurrent}><RotateCcw size={15} />回到目前配置</button>
                    <button className="ui-button ui-button-primary" onClick={() => void refreshPrices()} disabled={priceLoading}><RefreshCw size={15} className={priceLoading ? 'is-spinning' : undefined} />{priceLoading ? '更新中...' : '更新現價'}</button>
                </div>
            </div>

            {loading && hasLoaded && <p className="ui-refresh-status" role="status">資料更新中…</p>}
                {loading && !hasLoaded ? (
                <div style={{ padding: '80px 0', textAlign: 'center', color: 'var(--c-muted)' }}>正在整理目前投資組合...</div>
            ) : error ? (
                <div style={{ ...card, marginTop: '18px', color: 'var(--c-danger)' }}>{error}</div>
            ) : (
                <>
                    <div className="planner-summary">
                        {[
                            { title: '自有資金', value: money(equity), note: '持股市值＋現金－融資負債', color: 'var(--c-text)' },
                            { title: '目前股票水位', value: equity > 0 ? percent(marketValue / equity * 100) : '—', note: money(marketValue), color: 'var(--c-accent)' },
                            { title: '試算後股票水位', value: result ? percent(result.targetPositionPct) : '—', note: result ? money(result.targetStockMarketValue) : '請輸入有效水位', color: 'var(--c-purple)' },
                            { title: '預估剩餘現金', value: money(remainingCash), note: result ? `淨需資金 ${money(result.netCashRequired)}` : '—', color: remainingCash < 0 ? 'var(--c-danger)' : 'var(--c-positive)' },
                        ].map(item => (
                            <div key={item.title} className="planner-kpi" style={card}>
                                <div className="planner-kpi-label">{item.title}</div>
                                <div className="planner-kpi-value" style={{ color: item.color }}>{item.value}</div>
                                <div className="planner-kpi-note">{item.note}</div>
                            </div>
                        ))}
                    </div>

                    <div className="planner-workspace">
                        <div style={card}>
                            <div className="planner-section-head">
                                <div>
                                    <div className="planner-section-title"><Calculator size={18} color="var(--c-accent)" />水位與交易條件</div>
                                    
                                </div>
                            </div>
                            <div className="planner-position-grid">
                                <label>
                                    <span style={lbl}>目標股票水位（占自有資金）</span>
                                    <div className="planner-position-input"><input style={inp} type="number" min="0" step="0.1" value={targetPosition} onChange={event => setTargetPosition(event.target.value)} /><span>%</span></div>
                                </label>
                                <div className="planner-waterline" aria-label="目前與目標股票水位比較">
                                    {[
                                        { label: '目前水位', value: equity > 0 ? marketValue / equity * 100 : 0, color: 'var(--c-muted)' },
                                        { label: '目標水位', value: Math.max(0, Number(targetPosition) || 0), color: 'var(--c-accent)' },
                                    ].map(item => <div className="planner-waterline-row" key={item.label}><span>{item.label}</span><div className="planner-waterline-track"><div className="planner-waterline-fill" style={{ width: `${Math.min(item.value, 100)}%`, background: item.color }} /></div><strong style={{ color: item.color }}>{percent(item.value)}</strong></div>)}
                                </div>
                            </div>
                            <div className="planner-option-grid">
                                <label><span style={lbl}>執行模式</span><select style={inp} value={mode} onChange={event => setMode(event.target.value as typeof mode)}><option value="full">完整再平衡</option><option value="buy-only">只用現金加碼</option><option value="sell-only">只降低部位</option></select></label>
                                <label><span style={lbl}>交易單位</span><select style={inp} value={lotSize} onChange={event => setLotSize(Number(event.target.value) as 1 | 1000)}><option value={1}>整股／零股皆可</option><option value={1000}>只用整張（1,000 股）</option></select></label>
                                <label><span style={lbl}>單一個股上限（%）</span><input style={inp} type="number" min="0" step="1" value={maxWeight} onChange={event => setMaxWeight(event.target.value)} /></label>
                            </div>
                            <label style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '14px', color: 'var(--c-text)', fontSize: '13px' }}><input type="checkbox" checked={includeFees} onChange={event => setIncludeFees(event.target.checked)} />納入手續費與交易稅</label>
                        </div>
                        <div style={card}>
                            <div className="planner-section-head">
                                <div>
                                    <div className="planner-section-title"><Plus size={18} color="var(--c-positive)" />加入規劃標的</div>
                                    
                                </div>
                            </div>
                            <div className="planner-add-grid">
                                <label className="planner-code-field"><span style={lbl}>股票代號</span><input style={inp} value={newCode} onChange={event => setNewCode(event.target.value)} placeholder="例如 2330" /></label>
                                <label><span style={lbl}>名稱（選填）</span><input style={inp} value={newName} onChange={event => setNewName(event.target.value)} placeholder="股票名稱" /></label>
                                <label><span style={lbl}>參考價（選填）</span><input style={inp} type="number" value={newPrice} onChange={event => setNewPrice(event.target.value)} placeholder="價格" /></label>
                            </div>
                            <button className="ui-button ui-button-primary planner-add-action" onClick={addStock} disabled={!newCode.trim()}><Plus size={15} />加入組合</button>
                            <div className="planner-scenarios">
                                <input style={{ ...inp, flex: '1 1 150px' }} value={scenarioName} onChange={event => setScenarioName(event.target.value)} placeholder="方案名稱（選填）" />
                                <button className="ui-button ui-button-secondary" onClick={saveScenario} disabled={rows.length === 0}><Save size={14} />儲存方案</button>
                                {savedScenarios.map(scenario => (
                                    <span key={scenario.id} className="planner-scenario-chip">
                                        <button className="ui-button ui-button-secondary" onClick={() => applyScenario(scenario)}>{scenario.name}</button>
                                        <button className="ui-button ui-button-secondary" style={{ padding: '7px', borderLeft: '1px solid var(--c-border)' }} onClick={() => persistScenarios(savedScenarios.filter(item => item.id !== scenario.id))} aria-label={`刪除方案 ${scenario.name}`}><Trash2 size={12} /></button>
                                    </span>
                                ))}
                            </div>
                        </div>
                    </div>

                    {(weightOff || remainingCash < 0 || sellsTooManyShares || rows.some(row => row.priceFallback)) && (
                        <div style={{ ...card, padding: '13px 16px', marginBottom: '16px', borderColor: 'color-mix(in srgb, var(--c-warning) 45%, var(--c-border))', display: 'flex', alignItems: 'flex-start', gap: '10px' }}>
                            <AlertTriangle size={17} color="var(--c-warning)" style={{ flexShrink: 0, marginTop: '1px' }} />
                            <div style={{ color: 'var(--c-muted)', fontSize: '12px', lineHeight: 1.7 }}>
                                {weightOff && <div>個股目標占比目前合計 {result?.allocatedWeightPct.toFixed(1)}%，應為 100%。</div>}
                                {remainingCash < 0 && <div>依目前現金試算仍短缺 {money(Math.abs(remainingCash))}，需降低倉位或安排額外資金／融資。</div>}
                                {sellsTooManyShares && <div>賣出股數已限制為可用持股；整張模式不處理剩餘零股，需清倉請改用整股模式。</div>}
                                {rows.some(row => row.priceFallback) && <div>有股票尚無現價，暫以平均成本估算；更新現價後結果會更準確。</div>}
                            </div>
                        </div>
                    )}

                    <div style={{ ...card, marginBottom: '16px' }}>
                        <div className="planner-section-head">
                            <div>
                                <div className="planner-section-title"><Scale size={18} color="var(--c-purple)" />個股配置與建議交易</div>
                                <p className="planner-section-copy">以股票部位為基準，合計 100%。</p>
                            </div>
                            <div className="page-actions"><button className="ui-button ui-button-secondary" onClick={setEqualWeights}><Scale size={14} />平均配置</button><button className="ui-button ui-button-secondary" onClick={normalizeWeights}><WandSparkles size={14} />正規化為 100%</button></div>
                        </div>
                        {rows.length === 0 ? (
                            <div style={{ textAlign: 'center', padding: '44px 12px', color: 'var(--c-muted)' }}>目前沒有持股，請先加入想規劃的股票。</div>
                        ) : (
                            <div className="planner-table-wrap">
                                <table className="planner-table">
                                    <thead><tr><th>股票</th><th>目前股數</th><th>參考價</th><th>目前市值</th><th>目標占比</th><th>目標市值</th><th>建議動作</th><th>估算股數</th><th></th></tr></thead>
                                    <tbody>
                                        {result?.rows.map(calculated => {
                                            const row = rows.find(item => item.code === calculated.code)!
                                            const exceeds = calculated.limitedByHoldings
                                            const actionColor = calculated.action === 'buy' ? 'var(--c-positive)' : calculated.action === 'sell' ? 'var(--c-danger)' : 'var(--c-muted)'
                                            return (
                                                <tr key={row.id}>
                                                    <td><strong style={{ color: 'var(--c-accent)' }}>{row.code}</strong><div style={{ fontSize: '11px', color: 'var(--c-muted)', marginTop: '2px' }}>{row.name || '未命名'}</div></td>
                                                    <td>{row.currentShares.toLocaleString()}</td>
                                                    <td><input className="planner-mini-input" type="number" min="0" step="0.01" value={row.price} onChange={event => updateRow(row.id, { price: event.target.value, priceFallback: false })} aria-label={`${row.code} 參考價`} /></td>
                                                    <td>{money(row.currentMarketValue)}</td>
                                                    <td><div style={{ display: 'flex', alignItems: 'center', gap: '5px' }}><input className="planner-mini-input" type="number" min="0" step="0.1" value={row.targetWeight} onChange={event => updateRow(row.id, { targetWeight: event.target.value })} aria-label={`${row.code} 目標占比`} /><span style={{ color: 'var(--c-muted)' }}>%</span></div></td>
                                                    <td>{money(calculated.targetMarketValue)}</td>
                                                    <td><strong style={{ color: actionColor }}>{calculated.limitedByMode ? '模式略過' : calculated.action === 'buy' ? '買進' : calculated.action === 'sell' ? '賣出' : '不調整'} {calculated.action !== 'hold' && money(calculated.estimatedTradeValue)}</strong>{(calculated.estimatedFee + calculated.estimatedTax) > 0 && <div style={{ fontSize: '10px', color: 'var(--c-muted)', marginTop: '3px' }}>費稅約 {money(calculated.estimatedFee + calculated.estimatedTax)}</div>}</td>
                                                    <td style={{ color: exceeds ? 'var(--c-danger)' : 'var(--c-text)' }}>{calculated.estimatedShares === null ? '請補價格' : calculated.action === 'hold' ? '—' : `${calculated.estimatedShares.toLocaleString()} 股`}{exceeds && <div style={{ fontSize: '10px' }}>已限制可賣股數</div>}</td>
                                                    <td><button className="ui-button ui-button-secondary" style={{ minHeight: '32px', padding: '6px' }} onClick={() => row.currentShares > 0 ? updateRow(row.id, { targetWeight: '0' }) : setRows(current => current.filter(item => item.id !== row.id))} aria-label={row.currentShares > 0 ? `將 ${row.code} 設為清倉` : `移除 ${row.code}`} title={row.currentShares > 0 ? '設為清倉（目標 0%）' : '移除'}><Trash2 size={14} /></button></td>
                                                </tr>
                                            )
                                        })}
                                    </tbody>
                                </table>
                            </div>
                        )}
                        {result && (
                            <div className="planner-table-footer">
                                <span>占比合計 <strong style={{ color: weightOff ? 'var(--c-warning)' : 'var(--c-positive)' }}>{result.allocatedWeightPct.toFixed(1)}%</strong></span>
                                <span>預計買進 <strong style={{ color: 'var(--c-positive)' }}>{money(result.totalBuy)}</strong></span>
                                <span>預計賣出 <strong style={{ color: 'var(--c-danger)' }}>{money(result.totalSell)}</strong></span>
                                <span>預估費稅 <strong style={{ color: 'var(--c-warning)' }}>{money(result.totalFees + result.totalTaxes)}</strong></span>
                                <span>淨需資金 <strong style={{ color: result.netCashRequired > 0 ? 'var(--c-warning)' : 'var(--c-positive)' }}>{money(result.netCashRequired)}</strong></span>
                            </div>
                        )}
                    </div>

                    <div style={card}>
                        <div className="planner-section-head">
                            <div>
                                <div className="planner-section-title"><ShieldAlert size={18} color="var(--c-warning)" />組合風險檢查</div>
                                <p className="planner-section-copy">設定集中度、現金與槓桿限制。</p>
                            </div>
                        </div>
                        <div className="planner-risk-grid">
                            <label><span style={lbl}>產業占比上限 %</span><input style={inp} type="number" min="0" value={maxGroupWeight} onChange={event => setMaxGroupWeight(event.target.value)} /></label>
                            <label><span style={lbl}>最低現金水位 %</span><input style={inp} type="number" min="0" value={minCashPct} onChange={event => setMinCashPct(event.target.value)} /></label>
                            <label><span style={lbl}>融資／淨資產上限 %</span><input style={inp} type="number" min="0" value={maxMarginPct} onChange={event => setMaxMarginPct(event.target.value)} /></label>
                            <label><span style={lbl}>ETF 最低占比 %</span><input style={inp} type="number" min="0" value={minEtfWeightPct} onChange={event => setMinEtfWeightPct(event.target.value)} /></label>
                            <label><span style={lbl}>壓力測試跌幅 %</span><input style={inp} type="number" min="0" max="100" value={stressDropPct} onChange={event => setStressDropPct(event.target.value)} /></label>
                            <label><span style={lbl}>最大可承受損失</span><input style={inp} type="number" min="0" value={maxStressLoss} onChange={event => setMaxStressLoss(event.target.value)} placeholder="0 = 不限制" /></label>
                        </div>
                        <div className="planner-risk-summary">
                            {[
                                ['壓力損失', money(risk.stressLoss)],
                                ['壓力後淨資產', money(risk.stressedNetAssets)],
                                ['壓力後股票水位', risk.stressedPositionPct === null ? '無法計算' : percent(risk.stressedPositionPct)],
                                ['現金水位', percent(risk.cashPct)],
                                ['融資曝險', Number.isFinite(risk.marginPct) ? percent(risk.marginPct) : '∞'],
                                ['ETF 占股票部位', percent(risk.etfWeightPct)],
                            ].map(([label, value]) => <div key={label} className="planner-risk-stat"><div style={{ color: 'var(--c-muted)', fontSize: '10px' }}>{label}</div><strong style={{ display: 'block', color: 'var(--c-text)', fontSize: '14px', marginTop: '4px' }}>{value}</strong></div>)}
                        </div>
                        {risk.groupWeights.length > 0 && <div style={{ display: 'flex', gap: '7px', flexWrap: 'wrap', marginTop: '12px' }}>{risk.groupWeights.map(group => <span key={group.group} style={{ border: '1px solid var(--c-border)', background: 'var(--c-bg)', borderRadius: '20px', padding: '4px 9px', color: group.weightPct > Number(maxGroupWeight) ? 'var(--c-warning)' : 'var(--c-muted)', fontSize: '11px' }}>{group.group} {group.weightPct.toFixed(1)}%</span>)}</div>}
                        {risk.issues.length === 0 ? (
                            <div style={{ color: 'var(--c-positive)', fontSize: '12px', marginTop: '12px' }}>✓ 目前試算結果未超過設定的風險限制</div>
                        ) : (
                            <div style={{ display: 'grid', gap: '6px', marginTop: '12px' }}>{risk.issues.map(issue => <div key={issue.id} style={{ color: issue.severity === 'danger' ? 'var(--c-danger)' : 'var(--c-warning)', background: `color-mix(in srgb, ${issue.severity === 'danger' ? 'var(--c-danger)' : 'var(--c-warning)'} 8%, transparent)`, borderRadius: '7px', padding: '7px 9px', fontSize: '11px' }}>⚠ {issue.message}</div>)}</div>
                        )}
                    </div>

                    {hasLegacyScenarios && <p role="status" className="planner-disclaimer">此裝置有舊版共用方案，因無法確認所屬帳號，已保留原資料但不自動載入；請在目前帳號重新建立方案。</p>}
                    <DisclosureNote summary="未含滑價；方案僅存此帳號／裝置。">採參考價與系統費稅估算，交易前請核對券商；方案不含於 JSON 備份。</DisclosureNote>
                </>
            )}
        </div>
    )
}
