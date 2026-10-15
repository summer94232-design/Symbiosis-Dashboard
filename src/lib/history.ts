import { createHistoryReader } from './historyCache'
import { createBrowserHistoryStore } from './historyStore'
import { getHistoricalCandles as readFugleHistory } from './fugle'
import { authenticatedFetch } from './authenticatedFetch'
import { captureUserSession } from './userDB'
import { isFubonSnapshotEnabled } from './fubonSnapshot'
import type { HistoryResult } from './historyCache'

const reader = createHistoryReader({
    store: createBrowserHistoryStore(),
    primary: async (symbol, from, to): Promise<HistoryResult> => {
        // Keep the existing source until the real account's history entitlement
        // and OHLC/volume semantics have been checked before a later release.
        if (!isFubonSnapshotEnabled() || import.meta.env.VITE_FUBON_HISTORY_ENABLED !== 'true') throw new Error('富邦歷史尚未完成實測')
        const session = captureUserSession()
        // A queued historical task may wait for quota; the server never sleeps.
        for (let attempt = 0; attempt < 2; attempt++) {
            session.assertActive()
            const response = await authenticatedFetch('/.netlify/functions/fubon-history', session, {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ symbol, from, to }),
                signal: AbortSignal.timeout(25000),
            }, true)
            if (response.status === 429 && attempt === 0) {
                const seconds = Number(response.headers.get('Retry-After'))
                if (Number.isFinite(seconds) && seconds > 0 && seconds <= 75) {
                    await new Promise(resolve => setTimeout(resolve, seconds * 1000)); continue
                }
            }
            if (!response.ok) throw new Error(`富邦歷史行情 HTTP ${response.status}`)
            const data = await response.json()
            session.assertActive()
            return data
        }
        throw new Error('富邦歷史行情限流')
    },
    fallback: readFugleHistory,
})

// Module scope survives route changes. Captured auth prevents queued work from
// following an account switch; the cache contains public price bars only.
export async function getHistoricalCandles(symbol: string, from: string, to: string) {
    const session = captureUserSession()
    const result = await reader(symbol, from, to, session.assertActive)
    session.assertActive()
    return result
}
