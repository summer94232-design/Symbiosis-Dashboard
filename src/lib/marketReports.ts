import { authenticatedFetch } from './authenticatedFetch'
import { captureUserSession } from './userDB'
import type { MarketReport } from '../../netlify/lib/market-reports.js'
export type { MarketReport } from '../../netlify/lib/market-reports.js'
export interface MarketReportFeed {
    ownerUid: string
    latest: MarketReport
    selected: MarketReport | null
    reports: Array<Omit<MarketReport, 'content'>>
    source: { id: string; name: string; createdTime: string; fallback: boolean; invalidRows: number }
    holidays: string[]
    checkedAt: string
}
export async function fetchMarketReports({ report, refresh = false, signal }: { report?: string; refresh?: boolean; signal?: AbortSignal } = {}): Promise<MarketReportFeed> {
    const session = captureUserSession()
    const query = new URLSearchParams({ ...(report ? { report } : {}), ...(refresh ? { refresh: '1' } : {}) })
    const response = await authenticatedFetch('/.netlify/functions/market-reports' + (query.size ? `?${query}` : ''), session, { signal }, true)
    const data = await response.json()
    session.assertActive()
    if (!response.ok) throw Object.assign(new Error(data.error || '報告讀取失敗'), { reconnect: data.code === 'GOOGLE_RECONNECT' || data.code === 'GOOGLE_ACCESS' })
    if (data.ownerUid !== session.uid || !data.latest || !Array.isArray(data.reports)) throw new Error('報告回應與目前帳號不符')
    return data as MarketReportFeed
}
