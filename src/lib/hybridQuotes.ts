import { isPositivePrice, type QuoteObservation, type QuoteObservations } from './pricePolicy'
import { QUOTE_REFRESH_TIMEOUT_MS } from './quoteTiming'

/** The Fubon snapshot covers markets, not arbitrary individual symbols or IX0001. */
export function splitTaiwanQuoteCodes(codes: string[]): { snapshot: string[]; direct: string[] } {
    const snapshot: string[] = [], direct: string[] = []
    for (const code of new Set(codes)) {
        if (code === 'IX0001') direct.push(code)
        else snapshot.push(code)
    }
    return { snapshot, direct }
}

export interface HybridQuoteReaders {
    snapshot: (codes: string[], requestedAt: string) => Promise<QuoteObservations>
    fugle: (codes: string[], requestedAt: string, deadline?: number) => Promise<QuoteObservations>
}

export interface HybridQuoteResult {
    quotes: QuoteObservations
    unattempted: string[]
    snapshotError?: string
}

const missing = (requestedAt: string, message: string): QuoteObservation => ({
    price: null, requestedAt, fetchedAt: new Date().toISOString(), sourceDate: '', sourceUpdatedAt: null,
    priceType: 'missing', status: 'failed', error: message,
})

/**
 * Start known holding/index confirmations alongside the market snapshot.
 * Only the bounded gap repair depends on the snapshot response.
 * A snapshot outage never silently turns into a large, slow per-symbol refresh.
 */
export async function readHybridTaiwanQuotes(
    codes: string[], requestedAt: string, readers: HybridQuoteReaders, fallbackLimit = 10,
    preciseCodes: string[] = [],
): Promise<HybridQuoteResult> {
    const deadline = Date.now() + QUOTE_REFRESH_TIMEOUT_MS
    const { snapshot: marketCodes, direct } = splitTaiwanQuoteCodes(codes)
    if (!Number.isSafeInteger(fallbackLimit) || fallbackLimit < 0) throw new Error('Invalid fallback limit')
    const precise = new Set(preciseCodes.filter(code => marketCodes.includes(code)))
    const readFugle = async (symbols: string[]): Promise<QuoteObservations> => {
        if (!symbols.length) return {}
        try { return await readers.fugle(symbols, requestedAt, deadline) }
        catch { return {} } // One failed complement must not erase other successful sources.
    }
    let market: QuoteObservations = {}, snapshotError: string | undefined
    const marketRead = (async () => {
        if (marketCodes.length) {
            try { market = await readers.snapshot(marketCodes, requestedAt) }
            catch { snapshotError = '富邦快照暫時無法使用' }
        }
    })()
    const priorityRead = readFugle([...direct, ...precise])
    await marketRead
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(new Date(requestedAt))
    const failed = marketCodes.filter(code => market[code]?.status !== 'success'
        || !isPositivePrice(market[code]?.price) || market[code]?.sourceDate !== today)
    const uncovered = failed.filter(code => !precise.has(code))
    const [priority, repairs] = await Promise.all([priorityRead, readFugle(uncovered.slice(0, fallbackLimit))])
    const fugle = { ...priority, ...repairs }
    const quotes: QuoteObservations = {}
    for (const code of [...marketCodes, ...direct]) {
        const fromMarket = market[code], fromFugle = fugle[code]
        // A newer dated trade can repair an old market snapshot. Never regress its date/tick.
        const confirmed = fromFugle?.status === 'success' && fromFugle.priceType === 'trade'
            && isPositivePrice(fromFugle.price) && /^\d{4}-\d{2}-\d{2}$/.test(fromFugle.sourceDate)
            && (!fromMarket || fromMarket.status !== 'success' || !isPositivePrice(fromMarket.price)
                || (fromFugle.sourceDate >= fromMarket.sourceDate
                    && (fromFugle.sourceDate !== fromMarket.sourceDate || fromFugle.sourceUpdatedAt === null
                        || fromMarket.sourceUpdatedAt === null || fromFugle.sourceUpdatedAt >= fromMarket.sourceUpdatedAt)))
        quotes[code] = confirmed ? fromFugle
            : fromMarket?.status === 'success' && isPositivePrice(fromMarket.price) ? fromMarket
            : fromFugle?.status === 'success' && isPositivePrice(fromFugle.price) ? fromFugle
                : fromFugle ?? fromMarket ?? missing(requestedAt, snapshotError || '快照未涵蓋此代號')
    }
    return { quotes, unattempted: uncovered.slice(fallbackLimit), ...(snapshotError ? { snapshotError } : {}) }
}
