import { toLocalDateString } from './date'

export interface QuoteObservation {
    /** Ordered publications within one captured refresh. */
    revision?: number
    price: number | null
    requestedAt: string
    fetchedAt: string
    sourceDate: string
    sourceUpdatedAt: number | null
    priceType: 'trade' | 'reference' | 'missing'
    status: 'success' | 'failed' | 'stale'
    error?: string
    changePercent?: number
    /** Provider's final closing signal, never inferred from a trade price or clock. */
    isFinalClose?: boolean
}
export type QuoteObservations = Record<string, QuoteObservation>
export type SavedPrices = Record<string, unknown> & { _quotes?: QuoteObservations; _updatedAt?: string;
    _refresh?: { requestedAt: string; holdingCodes: string[] } }

export function isPositivePrice(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0
}

/** Current displays may use legacy numeric prices, but never a failed observation. */
export function getUsablePrices(saved: SavedPrices): Record<string, number> {
    return Object.fromEntries(Object.entries(saved).filter(([code, price]) => !code.startsWith('_') && isPositivePrice(price)
        && (!saved._quotes?.[code] || saved._quotes[code].status === 'success'))) as Record<string, number>
}

/** Pure transaction reducer: older requests and regressed source ticks cannot replace newer prices. */
export function mergeQuoteObservations(previous: SavedPrices, incoming: QuoteObservations): SavedPrices {
    const next: SavedPrices = { ...previous, _quotes: { ...previous._quotes } }
    for (const [code, observation] of Object.entries(incoming)) {
        const old = next._quotes![code]
        if (old && (old.requestedAt > observation.requestedAt || old.requestedAt === observation.requestedAt
            && (old.revision ?? 0) >= (observation.revision ?? 0))) continue
        if (old?.requestedAt === observation.requestedAt && old.status === 'success' && observation.status !== 'success') continue
        const regressed = old && observation.status === 'success' && (
            observation.sourceDate < old.sourceDate || (observation.sourceDate === old.sourceDate
                && old.sourceUpdatedAt !== null && observation.sourceUpdatedAt !== null
                && observation.sourceUpdatedAt < old.sourceUpdatedAt))
        if (regressed && old.requestedAt === observation.requestedAt) continue
        next._quotes![code] = old && (regressed || observation.status !== 'success')
            ? { ...observation, sourceDate: old.sourceDate, sourceUpdatedAt: old.sourceUpdatedAt,
                status: regressed ? 'stale' : observation.status }
            : observation
        if (!regressed && observation.status === 'success' && isPositivePrice(observation.price)) {
            next[code] = observation.price
            // This is only the last successful fetch time, never proof that every symbol is fresh.
            if (!next._updatedAt || Date.parse(observation.fetchedAt) > Date.parse(next._updatedAt)
                || !Number.isFinite(Date.parse(next._updatedAt))) next._updatedAt = observation.fetchedAt
        }
    }
    return next
}

export function stalePriceCodes(codes: string[], saved: SavedPrices, asOf = toLocalDateString()): string[] {
    return codes.filter(code => {
        const quote = saved._quotes?.[code]
        if (saved._refresh?.holdingCodes.includes(code) && (!quote || quote.requestedAt < saved._refresh.requestedAt)) return true
        if (!quote || quote.status !== 'success'
            || !isPositivePrice(saved[code]) || saved[code] !== quote.price || quote.sourceDate !== asOf) return true
        const fetched = new Date(quote.fetchedAt)
        return !Number.isFinite(fetched.getTime()) || toLocalDateString(fetched) !== asOf
    })
}

/** Explain incomplete or outdated quotes for daily trend captures. */
export function describeSnapshotPriceIssues(codes: string[], saved: SavedPrices, asOf: string): string {
    const groups = new Map<string, string[]>()
    for (const code of codes) {
        const quote = saved._quotes?.[code]
        const reason = saved._refresh?.holdingCodes.includes(code) && (!quote || quote.requestedAt < saved._refresh.requestedAt)
            ? '本次持股報價尚未完成' : !quote || quote.status !== 'success' ? '未取得有效報價'
            : quote.sourceDate !== asOf ? `來源日期 ${quote.sourceDate || '未知'}`
            : !isPositivePrice(saved[code]) || saved[code] !== quote.price ? '儲存價格與報價不一致'
            : '並非今日取得的報價'
        const list = groups.get(reason) ?? []
        list.push(code)
        groups.set(reason, list)
    }
    return [...groups].map(([reason, list]) => `${reason}（${list.join('、')}）`).join('；')
}
