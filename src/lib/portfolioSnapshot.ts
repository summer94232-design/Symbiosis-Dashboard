import { getDoc } from 'firebase/firestore'
import { investDB } from './firebase'
import { userDocNested } from './userDB'
import { fetchCashflow, fetchDividends, fetchTrades } from './investData'
import {
    aggregateMarginDebt,
    aggregateMarginPositions,
    calcAvailableCash,
    calcGrossAmount,
    calcPositions,
    calcReturnRate,
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
    prices: Record<string, number>
    priceUpdatedAt: string
}

export interface BuildPortfolioSnapshotInput {
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
    const { holdings: positions, realized } = calcPositions(input.trades, input.dividends)
    const prices: Record<string, number> = {}
    Object.entries(input.savedPrices ?? {}).forEach(([code, value]) => {
        if (code !== '_updatedAt' && positivePrice(value)) prices[code] = value
    })
    Object.entries(input.priceOverrides ?? {}).forEach(([code, value]) => {
        if (positivePrice(value)) prices[code] = value
    })

    const activePositions = Object.values(positions).filter(position => position.shares > 0)
    let marketValue = 0
    const holdings = activePositions.map(position => {
        const currentPrice = positivePrice(prices[position.code]) ? prices[position.code] : null
        const value = currentPrice !== null ? calcGrossAmount(currentPrice, position.shares) : position.totalCost
        const unrealizedPnL = currentPrice !== null ? value - position.totalCost : 0
        const marginAmount = position.marginAmount ?? 0
        marketValue += value
        return {
            code: position.code,
            name: position.name,
            shares: position.shares,
            avgCost: position.avgCost,
            totalCost: position.totalCost,
            marginAmount,
            currentPrice,
            priceSource: currentPrice === null ? 'cost' as const : 'market' as const,
            marketValue: value,
            unrealizedPnL,
            returnRate: calcReturnRate(unrealizedPnL, position.totalCost, marginAmount),
            ratio: 0,
        }
    })
    holdings.forEach(holding => { holding.ratio = marketValue > 0 ? holding.marketValue / marketValue * 100 : 0 })
    holdings.sort((a, b) => b.marketValue - a.marketValue)

    const cash = calcAvailableCash(input.cashflow, input.trades, input.dividends)
    const marginPositions = aggregateMarginPositions(input.trades)
    const marginDebt = aggregateMarginDebt(input.trades)
    const grossAssets = marketValue + cash
    const netAssets = grossAssets - marginDebt

    return {
        trades: input.trades,
        dividends: input.dividends,
        cashflow: input.cashflow,
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
        prices,
        priceUpdatedAt: input.priceUpdatedAt
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
