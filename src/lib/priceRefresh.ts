export interface QuoteRefreshResult<T = unknown> {
    prices: Record<string, number | null>
    detail?: T
}

/** One account's shared refresh, including requests arriving during a batch. */
export function createPriceRefreshCoordinator<T>(
    loadCodes: () => Promise<string[]>,
    refresh: (codes: string[]) => Promise<QuoteRefreshResult<T>>,
    now = Date.now,
) {
    let running: Promise<QuoteRefreshResult<T>> | null = null
    const validUntil = new Map<string, number>()
    let previous: QuoteRefreshResult<T> = { prices: {} }
    const requested = new Set<string>()
    return (codes: string[] = []): Promise<QuoteRefreshResult<T>> => {
        codes.forEach(code => requested.add(code))
        if (running) return running
        running = (async () => {
            const universe = await loadCodes()
            universe.forEach(code => requested.add(code))
            const result: QuoteRefreshResult<T> = { prices: Object.fromEntries(Object.entries(previous.prices)
                .filter(([code]) => (validUntil.get(code) ?? 0) > now())) }
            const attempted = new Set<string>()
            while (requested.size) {
                const batch = [...requested].filter(code => !attempted.has(code) && !(typeof result.prices[code] === 'number' && result.prices[code]! > 0))
                requested.clear()
                if (!batch.length) continue
                batch.forEach(code => attempted.add(code))
                const fresh = await refresh(batch)
                Object.assign(result.prices, fresh.prices)
                batch.forEach(code => validUntil.set(code, now() + 60000))
                result.detail = fresh.detail
            }
            // Reusing a result must not extend its lifetime indefinitely.
            if (attempted.size) previous = result
            return result
        })().finally(() => { running = null; requested.clear() })
        return running
    }
}
