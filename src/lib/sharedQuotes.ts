import { getMultipleQuoteObservations } from './fugle'
import { getForeignQuotes } from './foreignQuote'
import { isPositivePrice, type QuoteObservations } from './pricePolicy'
import { readHybridTaiwanQuotes } from './hybridQuotes'
import { getFubonSnapshotObservations, isFubonSnapshotEnabled } from './fubonSnapshot'

export async function getSharedQuoteObservations(
    codes: string[], requestedAt: string, mode: 'global' | 'direct' = 'global', preciseCodes: string[] = [],
    onQuotes?: (quotes: QuoteObservations) => Promise<void> | void,
): Promise<QuoteObservations> {
    const unique = [...new Set(codes)]
    const foreign = unique.filter(code => /^(US|JP):/.test(code))
    const domestic = unique.filter(code => !foreign.includes(code))
    const foreignRead = async (): Promise<QuoteObservations> => {
        if (!foreign.length) return {}
        const symbols = foreign.map(key => key.startsWith('JP:') ? `${key.slice(3)}.T` : key.slice(3))
        let quotes: Record<string, number | null> = {}, error = ''
        try { quotes = await getForeignQuotes(symbols) }
        catch (cause) { error = cause instanceof Error ? cause.message : '外股報價暫時無法使用' }
        const observations: QuoteObservations = Object.fromEntries(foreign.map((key, i) => {
            const value = quotes[symbols[i]]
            const price = isPositivePrice(value) ? value : null
            return [key, { price, requestedAt, fetchedAt: new Date().toISOString(), sourceDate: '', sourceUpdatedAt: null,
                priceType: price === null ? 'missing' : 'trade', status: price === null ? 'failed' : 'success',
                ...(price === null ? { error: error || '此股票暫無有效報價' } : {}) }]
        }))
        await onQuotes?.(observations)
        return observations
    }
    const domesticRead = () => mode === 'global' && isFubonSnapshotEnabled()
        ? readHybridTaiwanQuotes(domestic, requestedAt, {
            snapshot: getFubonSnapshotObservations, fugle: getMultipleQuoteObservations,
        }, 10, preciseCodes, onQuotes).then(result => result.quotes)
        : getMultipleQuoteObservations(domestic, requestedAt, undefined, onQuotes)
    const [tw, overseas] = await Promise.all([domesticRead(), foreignRead()])
    return { ...tw, ...overseas }
}
