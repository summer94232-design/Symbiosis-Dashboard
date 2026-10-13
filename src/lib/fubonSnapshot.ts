import { authenticatedFetch } from './authenticatedFetch'
import { captureUserSession } from './userDB'
import { normalizeFubonSnapshots } from './fubonSnapshotPolicy'
import type { QuoteObservations } from './pricePolicy'

export function isFubonSnapshotEnabled(): boolean {
    return import.meta.env.VITE_FUBON_SNAPSHOT_ENABLED === 'true'
}

export async function getFubonSnapshotObservations(codes: string[], requestedAt: string): Promise<QuoteObservations> {
    if (!codes.length) return {}
    const session = captureUserSession()
    const response = await authenticatedFetch('/.netlify/functions/fubon-snapshot', session, {
        signal: AbortSignal.timeout(8000), method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ codes }),
    })
    const body = await response.json()
    session.assertActive()
    if (!Array.isArray(body.snapshots)) throw new Error('富邦快照資料格式異常')
    const observations: QuoteObservations = {}
    for (const snapshot of body.snapshots) {
        const fetchedAt = typeof snapshot?.fetchedAt === 'string' ? snapshot.fetchedAt : new Date().toISOString()
        Object.assign(observations, normalizeFubonSnapshots([snapshot], codes, requestedAt, fetchedAt))
    }
    return observations
}
