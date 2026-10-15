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
    fugle: (codes: string[], requestedAt: string, deadline?: number,
        onQuote?: (quotes: QuoteObservations) => Promise<void> | void) => Promise<QuoteObservations>
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
    onQuotes?: (quotes: QuoteObservations) => Promise<void> | void,
): Promise<HybridQuoteResult> {
    const deadline = Date.now() + QUOTE_REFRESH_TIMEOUT_MS
    const { snapshot: marketCodes, direct } = splitTaiwanQuoteCodes(codes)
    if (!Number.isSafeInteger(fallbackLimit) || fallbackLimit < 0) throw new Error('Invalid fallback limit')
    const precise = new Set(preciseCodes.filter(code => marketCodes.includes(code)))
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(new Date(requestedAt))
    const published = new Set<string>()
    const publish = async (quotes: QuoteObservations) => {
        const fresh = Object.fromEntries(Object.entries(quotes).filter(([code, q]) => !published.has(code)
            && q.status === 'success' && isPositivePrice(q.price) && q.sourceDate === today
            && (!precise.has(code) || q.priceType === 'trade')))
        Object.keys(fresh).forEach(code => published.add(code))
        if (Object.keys(fresh).length) await onQuotes?.(fresh)
    }
    const readFugle = async (symbols: string[]): Promise<QuoteObservations> => {
        if (!symbols.length) return {}
        try {
            const result = await readers.fugle(symbols, requestedAt, deadline, publish)
            await publish(result)
            return result
        }
        catch { return {} } // One failed complement must not erase other successful sources.
    }
    let market: QuoteObservations = {}, snapshotError: string | undefined
    const marketRead = (async () => {
        if (marketCodes.length) {
            try {
                market = await readers.snapshot(marketCodes, requestedAt)
                // Holding confirmations get first choice; market rows for other
                // symbols can be committed while those confirmations are pending.
                const others = Object.fromEntries(Object.entries(market).filter(([code]) => !precise.has(code)))
                await publish(others)
            }
            catch { snapshotError = '富邦快照暫時無法使用' }
        }
    })()
    const priorityRead = readFugle([...direct, ...precise])
    await marketRead
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
