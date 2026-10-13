import { authenticatedFetch } from './authenticatedFetch'
import { captureUserSession } from './userDB'
import { calcPositions, type TradeRecord, type DividendRecord } from './calc'
import { normalizeTaiwanStockCode } from './investmentValidation'
import { publicDividendCatalog, type DividendCatalog, type DividendAnnouncement } from '../../netlify/lib/dividend-announcements.js'

export interface DividendFeedState { catalog: DividendCatalog | null; loading: boolean; error: string }
export interface DividendForecast {
    announcement: DividendAnnouncement; shares: number; cashGross: number | null; stockShares: number
    stockFraction: number; hasMargin: boolean; foreignCurrency: boolean
}
const CACHE_KEY = 'symbiosis.dividend.announcements'
let state: DividendFeedState = { catalog: null, loading: false, error: '' }
let lastReadAt = 0
let pending: Promise<void> | null = null
const listeners = new Set<() => void>()
function publish(next: DividendFeedState) { state = next; listeners.forEach(listener => listener()) }
export const getDividendFeedState = () => state
export function subscribeDividendFeed(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } }
// Only public rates/dates are cached. Entitlement shares are always computed from the active account.
try {
    const text = localStorage.getItem(CACHE_KEY)
    if (text && text.length < 850000) {
        const saved = JSON.parse(text), catalog = publicDividendCatalog(saved.catalog)
        if (catalog && Number.isFinite(saved.readAt) && saved.readAt <= Date.now()) {
            state = { catalog, loading: false, error: saved.refreshFailures?.some((market: unknown) => market === 'TWSE' || market === 'TPEX') ? '部分官方公告暫時無法更新，保留上一份預告；請核對更新時間。' : '' }; lastReadAt = saved.readAt
        }
    }
} catch { /* Cache is optional, corrupt data cannot become a forecast. */ }

export async function updateDividendAnnouncements(session = captureUserSession(), now = Date.now()): Promise<void> {
    session.assertActive()
    if (pending) { await pending; session.assertActive(); return }
    if (now >= lastReadAt && now - lastReadAt < (state.error ? 60000 : 86400000)) return
    pending = (async () => {
        publish({ ...state, loading: true, error: '' })
        // Also bound unsuccessful clicks locally. The server has its own persistent global cooldown.
        lastReadAt = now
        try {
            const response = await authenticatedFetch('/.netlify/functions/dividend-announcements', session)
            const data = await response.json()
            session.assertActive()
            const catalog = publicDividendCatalog(data)
            if (!catalog) throw new Error('除權息公告格式不完整')
            publish({ catalog, loading: false, error: Array.isArray(data.refreshFailures) && data.refreshFailures.length
                ? '部分官方公告暫時無法更新，保留上一份預告；請核對更新時間。' : '' })
            try { localStorage.setItem(CACHE_KEY, JSON.stringify({ catalog, readAt: now, refreshFailures: Array.isArray(data.refreshFailures) ? data.refreshFailures.filter((market: unknown) => market === 'TWSE' || market === 'TPEX') : [] })) } catch { /* Optional public cache. */ }
        } catch (error) {
            publish({ ...state, loading: false, error: error instanceof Error ? error.message : '除權息公告更新失敗，保留上一份預告' })
        }
    })().finally(() => { pending = null })
    await pending
    session.assertActive()
}

export function buildDividendForecasts(catalog: DividendCatalog | null, trades: TradeRecord[], dividends: DividendRecord[], today: string): DividendForecast[] {
    if (!catalog) return []
    const normalizedTrades = trades.map(row => ({ ...row, code: normalizeTaiwanStockCode(row.code) }))
    const normalizedDividends = dividends.map(row => ({ ...row, code: normalizeTaiwanStockCode(row.code) }))
    const codes = new Set(normalizedTrades.map(row => row.code))
    const snapshots = new Map<string, ReturnType<typeof calcPositions>>()
    return catalog.entries.flatMap(announcement => {
        if (!announcement.active || !codes.has(announcement.code) || normalizedDividends.some(row => row.code === announcement.code && row.date === announcement.date)) return []
        const previousDay = new Date(Date.parse(announcement.date) - 86400000).toISOString().slice(0, 10)
        const asOf = previousDay < today ? previousDay : today
        let positions = snapshots.get(asOf)
        if (!positions) {
            positions = calcPositions(normalizedTrades, normalizedDividends, { asOf, includeInventoryLots: true })
            snapshots.set(asOf, positions)
        }
        const shares = positions.holdings[announcement.code]?.shares || 0
        if (shares <= 0 || (announcement.cashPerShare === 0 && announcement.stockRatio === 0)) return []
        const rawStock = shares * announcement.stockRatio
        // Official ratios have eight decimal places; near-integer precision loss is a forecast only.
        const stockShares = Math.floor(rawStock + Math.max(1e-8, shares * 1e-8))
        return [{ announcement, shares, cashGross: announcement.cashPerShare === null ? null : Math.round(shares * announcement.cashPerShare * 100) / 100,
            stockShares, stockFraction: Math.max(0, rawStock - stockShares),
            hasMargin: (positions.inventoryLots?.[announcement.code] || []).some(lot => lot.isMargin && lot.shares > 0),
            foreignCurrency: announcement.code.endsWith('C') }]
    }).sort((a, b) => a.announcement.date.localeCompare(b.announcement.date) || a.announcement.code.localeCompare(b.announcement.code))
}
