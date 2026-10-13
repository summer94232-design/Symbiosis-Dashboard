import { stalePriceCodes, type SavedPrices } from './pricePolicy'
import { toLocalDateString } from './date'
import { getDoc } from 'firebase/firestore'
import { investDB } from './firebase'
import { userDocNested } from './userDB'
import { fetchCashflow, fetchDividends, fetchTrades } from './investData'
import {
    aggregateMarginDebt,
    aggregateMarginPositions,
    calcAvailableCash,
    calcHoldingValuation,
    calcPositions,
    isEffectiveOn,
    type DividendRecord,
    type MarginPositionAgg,
    type TradeRecord,
} from './calc'

export interface CashflowRecord {
    id?: string
    date?: string
    type: string
    amount: number
}

export interface PortfolioHoldingSnapshot {
    code: string
    name: string
    shares: number
    avgCost: number
    totalCost: number
    marginAmount: number
    currentPrice: number | null
    priceSource: 'market' | 'cost'
    marketValue: number
    unrealizedPnL: number
    returnRate: number
    ratio: number
}

export interface PortfolioSnapshot {
    trades: TradeRecord[]
    dividends: DividendRecord[]
    cashflow: CashflowRecord[]
    holdings: PortfolioHoldingSnapshot[]
    marginPositions: MarginPositionAgg[]
    realizedPnL: number
    marketValue: number
    totalCost: number
    cash: number
    marginDebt: number
    grossAssets: number
    netAssets: number
    equityCapital: number
    positionPct: number | null
    hasMarketPrice: boolean
    missingPriceCodes: string[]
    stalePriceCodes: string[]
    prices: Record<string, number>
    savedPriceData: SavedPrices
    priceUpdatedAt: string
}

export interface BuildPortfolioSnapshotInput {
    asOf?: string
    trades: TradeRecord[]
    dividends: DividendRecord[]
    cashflow: CashflowRecord[]
    savedPrices?: Record<string, unknown>
    priceOverrides?: Record<string, number | null | undefined>
    priceUpdatedAt?: string
}

const positivePrice = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0

/** 投資區所有頁面的唯一彙總口徑。純函式，方便測試與跨頁重用。 */
export function buildPortfolioSnapshot(input: BuildPortfolioSnapshotInput): PortfolioSnapshot {
    const asOf = input.asOf ?? toLocalDateString()
    const trades = input.trades.filter(t => isEffectiveOn(t.date, asOf))
    const cashflow = input.cashflow.filter(c => isEffectiveOn(c.date, asOf))
    const { holdings: positions, realized } = calcPositions(trades, input.dividends, { asOf })
    const prices: Record<string, number> = {}
    Object.entries(input.savedPrices ?? {}).forEach(([code, value]) => {
        if (code !== '_updatedAt' && positivePrice(value)) prices[code] = value
    })
    Object.entries(input.priceOverrides ?? {}).forEach(([code, value]) => {
        if (positivePrice(value) && !(input.savedPrices as SavedPrices | undefined)?._quotes?.[code]) prices[code] = value
    })

    for (const [code, quote] of Object.entries((input.savedPrices as SavedPrices | undefined)?._quotes || {})) {
        if (quote.status !== 'success') delete prices[code]
    }
    const activePositions = Object.values(positions).filter(position => position.shares > 0)
    let marketValue = 0
    const holdings = activePositions.map(position => {
        // 持股來自完整成交帳，出借股票仍屬於資產，不以券商可下單股數取代。
        const valuation = calcHoldingValuation(position, prices[position.code], asOf)
        const marginAmount = position.marginAmount ?? 0
        marketValue += valuation.marketValue
        return {
            code: position.code,
            name: position.name,
            shares: position.shares,
            avgCost: position.avgCost,
            totalCost: position.totalCost,
            marginAmount,
            ...valuation,
            priceSource: valuation.currentPrice === null ? 'cost' as const : 'market' as const,
            ratio: 0,
        }
    })
    holdings.forEach(holding => { holding.ratio = marketValue > 0 ? holding.marketValue / marketValue * 100 : 0 })
    holdings.sort((a, b) => b.marketValue - a.marketValue)

    const cash = calcAvailableCash(cashflow, trades, input.dividends, asOf)
    const marginPositions = aggregateMarginPositions(trades, asOf, input.dividends)
    const marginDebt = aggregateMarginDebt(trades, asOf, input.dividends)
    const grossAssets = marketValue + cash
    const netAssets = grossAssets - marginDebt
    const stale = stalePriceCodes(holdings.map(h => h.code), input.savedPrices as SavedPrices || {}, asOf)

    return {
        trades,
        dividends: input.dividends,
        cashflow,
        holdings,
        marginPositions,
        realizedPnL: realized.reduce((sum, row) => sum + row.realized, 0),
        marketValue,
        totalCost: holdings.reduce((sum, row) => sum + row.totalCost, 0),
        cash,
        marginDebt,
        grossAssets,
        netAssets,
        equityCapital: netAssets,
        positionPct: netAssets > 0 ? marketValue / netAssets * 100 : null,
        hasMarketPrice: holdings.some(holding => holding.currentPrice !== null),
        missingPriceCodes: holdings.filter(holding => holding.currentPrice === null).map(holding => holding.code),
        stalePriceCodes: stale,
        savedPriceData: input.savedPrices as SavedPrices || {},
        prices,
        priceUpdatedAt: stale.length ? '' : input.priceUpdatedAt
            ?? (typeof input.savedPrices?._updatedAt === 'string' ? input.savedPrices._updatedAt : ''),
    }
}

/** 從共用投資快取與現價設定載入完整快照。 */
export async function loadPortfolioSnapshot(
    priceOverrides: Record<string, number | null | undefined> = {},
): Promise<PortfolioSnapshot> {
    const [trades, dividends, cashflow, priceDoc] = await Promise.all([
        fetchTrades<TradeRecord>('asc'),
        fetchDividends<DividendRecord>('asc'),
        fetchCashflow<CashflowRecord>('asc'),
        getDoc(userDocNested(investDB, 'settings', 'lastPrices')),
    ])
    const savedPrices: Record<string, unknown> = priceDoc.exists() ? priceDoc.data() : {}
    return buildPortfolioSnapshot({ trades, dividends, cashflow, savedPrices, priceOverrides })
}
