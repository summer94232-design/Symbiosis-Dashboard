import { authenticatedFetch } from './authenticatedFetch'
import { applyFomcCalendar } from './calendarData'
import { applySettlementCalendar } from './calc'
import { validateAnnualEntry } from '../../netlify/lib/annual-calendars.js'

/** Public calendar data only. Never persist user IDs, tokens or account data. */
const CACHE_KEY = 'symbiosis.annual.calendars'
let lastSuccessAt: string | null = null
const listeners = new Set<() => void>()
export const getAnnualCalendarLastSuccessAt = () => lastSuccessAt
export function subscribeAnnualCalendarStatus(listener: () => void) {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
}
export async function loadAnnualCalendars(): Promise<void> {
    const verified: Record<string, Record<string, ReturnType<typeof validateAnnualEntry>>> = { fomc: {}, settlement: {} }
    const apply = (data: Record<string, unknown>) => {
        if (!data || typeof data !== 'object') return
        for (const kind of ['fomc', 'settlement'] as const) {
            const rows = data[kind]
            if (!rows || typeof rows !== 'object' || Array.isArray(rows) || Object.keys(rows).length > 81) continue
            for (const [key, value] of Object.entries(rows)) {
                try {
                    if (!/^20\d{2}$/.test(key)) continue
                    const year = Number(key), row = validateAnnualEntry(kind, year, value)
                    if (verified[kind][key]?.checkedAt && verified[kind][key].checkedAt > row.checkedAt) continue
                    verified[kind][key] = row
                    if (kind === 'fomc') applyFomcCalendar(year, row.dates)
                    else applySettlementCalendar(year, row.dates)
                } catch { /* Invalid or unpublished years never replace a verified calendar. */ }
            }
        }
        // Legacy caches / bundled dates alone do not prove that the scheduled job succeeded.
        const timestamp = typeof data.lastSuccessAt === 'string' ? Date.parse(data.lastSuccessAt) : NaN
        const matchesVerifiedRow = Object.values(verified).some(rows => Object.values(rows).some(row => Date.parse(row.checkedAt) === timestamp))
        if (Number.isFinite(timestamp) && matchesVerifiedRow && (!lastSuccessAt || timestamp > Date.parse(lastSuccessAt))) {
            lastSuccessAt = new Date(timestamp).toISOString()
            listeners.forEach(listener => listener())
        }
    }
    try {
        const cached = localStorage.getItem(CACHE_KEY)
        if (cached && cached.length <= 100000) apply(JSON.parse(cached))
    } catch { /* Browser storage is optional and contains public schedules only. */ }
    try {
        const response = await authenticatedFetch('/.netlify/functions/annual-calendars', undefined, { signal: AbortSignal.timeout(10000) })
        apply(await response.json())
        try { localStorage.setItem(CACHE_KEY, JSON.stringify({ ...verified, lastSuccessAt })) } catch { /* Quota / private browsing. */ }
    } catch { /* Offline / unavailable: retain verified public dates and missing-year notices. */ }
}
