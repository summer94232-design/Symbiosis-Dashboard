import { getDocs } from 'firebase/firestore'
import { investDB } from './firebase'
import { captureUserSession } from './userDB'
import { fetchTrades, fetchDividends } from './investData'
import { calcPositions, type TradeRecord, type DividendRecord } from './calc'
import { toLocalDateString } from './date'
import { cache } from './cache'

/** Taiwan retains legacy keys; foreign markets cannot collide with Taiwan codes. */
export function quoteKey(code: string, market = ''): string {
    const symbol = code.trim().toUpperCase()
    // Already-qualified keys must remain stable when combined across saved lists.
    if (/^(US|JP):/.test(symbol)) return symbol
    const explicitMarket = market.trim().toUpperCase()
    // Legacy lists can omit market. Infer only unambiguous symbol shapes;
    // numeric Taiwan ETFs (including letter suffixes) and IX0001 stay domestic.
    const exchange = explicitMarket || (/^[A-Z]+(?:[.-][A-Z]+)?$/.test(symbol) ? 'US'
        : /^\d{4}\.T$/.test(symbol) ? 'JP' : 'TW')
    if (exchange === 'US') return `US:${symbol}`
    if (exchange === 'JP') return `JP:${symbol.replace(/\.T$/, '')}`
    return symbol.replace(/\.(TW|TWO)$/, '')
}

export function collectQuoteCodes(groups: { code?: unknown; market?: unknown }[][]): string[] {
    return [...new Set(groups.flat().flatMap(row => typeof row.code === 'string' && row.code.trim()
        ? [quoteKey(row.code, typeof row.market === 'string' ? row.market : '')] : []))]
}

/** Read the full saved universe, including pages the user has never mounted. */
export async function loadGlobalQuoteCodes(): Promise<string[]> {
    const session = captureUserSession()
    const codes = await cache.getOrLoad(`quotes:universe:${session.uid}`, async () => {
        const [trades, ...lists] = await Promise.all([
            fetchTrades<{ code: string }>(),
            ...['watchlist', 'sentiments', 'industryMap'].map(async name => {
                const snap = await getDocs(session.col(investDB, name))
                return snap.docs.map(doc => ({ ...(name !== 'sentiments' ? { code: doc.id } : {}), ...doc.data() }))
            }),
        ])
        session.assertActive()
        return collectQuoteCodes([trades, ...lists, [{ code: 'IX0001' }]])
    }, 90)
    session.assertActive()
    return codes
}

export function invalidateQuoteUniverse(): void { cache.invalidatePrefix('quotes:universe:') }

/** Holding verification only needs inventory; skip price and cash-flow reads. */
export async function loadHoldingQuoteCodes(): Promise<string[]> {
    const session = captureUserSession()
    const [trades, dividends] = await Promise.all([fetchTrades<TradeRecord>(), fetchDividends<DividendRecord>()])
    session.assertActive()
    const positions = calcPositions(trades, dividends, { asOf: toLocalDateString() })
    return [...new Set(Object.values(positions.holdings).filter(holding => holding.shares > 0).map(holding => quoteKey(holding.code)))]
}
