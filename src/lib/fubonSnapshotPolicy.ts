import { isPositivePrice, type QuoteObservations } from './pricePolicy'

type SnapshotRow = Record<string, unknown>
type Snapshot = Record<string, unknown>

/** Convert documented market responses to the application's quote contract. */
export function normalizeFubonSnapshots(
    responses: unknown[], requestedCodes: string[], requestedAt: string, fetchedAt: string,
): QuoteObservations {
    const wanted = new Set(requestedCodes)
    const quotes: QuoteObservations = {}
    for (const raw of responses) {
        if (!raw || typeof raw !== 'object') continue
        const market = raw as Snapshot
        const date = typeof market.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(market.date) ? market.date : ''
        if (!Array.isArray(market.data)) continue
        for (const item of market.data) {
            if (!item || typeof item !== 'object') continue
            const row = item as SnapshotRow
            const symbol = typeof row.symbol === 'string' ? row.symbol : ''
            if (!wanted.has(symbol) || quotes[symbol]) continue
            // lastPrice may contain auction trial prices. Normal snapshot rows may omit isTrial.
            const trade = row.isTrial === false && isPositivePrice(row.lastPrice) ? row.lastPrice : null
            // closePrice is usable for display, but does not prove an exact final close.
            const reference = row.isTrial !== true && isPositivePrice(row.closePrice) ? row.closePrice : null
            const price = trade ?? reference
            quotes[symbol] = {
                price, requestedAt, fetchedAt, sourceDate: date, sourceUpdatedAt: null,
                priceType: trade !== null ? 'trade' : reference !== null ? 'reference' : 'missing',
                status: price !== null && date ? 'success' : 'failed',
                ...(price === null || !date ? { error: '富邦快照缺少有效價格或日期' } : {}),
                ...(typeof row.changePercent === 'number' && Number.isFinite(row.changePercent)
                    ? { changePercent: row.changePercent } : {}),
            }
        }
    }
    return quotes
}
