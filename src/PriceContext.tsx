/* eslint-disable react-refresh/only-export-components */
/**
 * PriceContext.tsx
 * 全域現價管理 Context — v1.0
 *
 * 放置位置：src/PriceContext.tsx（與 App.tsx 同層）
 *
 * 設計原則：
 * - updatePrices 除了更新全域 state，也直接回傳本次取得的 quotes
 *   讓各頁面 wrapper 可以同步拿到最新值，避免非同步 state 讀到舊值
 * - loadCachedPrices 供頁面 load() 初始化時呼叫，不打 Fugle API
 * - Firebase transaction 逐檔合併並防止舊請求覆蓋新報價
 */

import { createContext, useContext, useState, useCallback, useEffect, useRef, type ReactNode } from 'react'
import { onSnapshot, runTransaction, type Unsubscribe } from 'firebase/firestore'
import { investDB } from './lib/firebase'
import { captureUserSession, userDocNested } from './lib/userDB'
import { getSharedQuoteObservations } from './lib/sharedQuotes'
import { isFubonSnapshotEnabled } from './lib/fubonSnapshot'
import { loadGlobalQuoteCodes, loadHoldingQuoteCodes } from './lib/quoteUniverse'
import { createPriceRefreshCoordinator, type QuoteRefreshResult } from './lib/priceRefresh'
import { maybeAutoSnapshotToday, type AutoSnapshotResult } from './lib/snapshot'
import { mergeQuoteObservations, type SavedPrices, type QuoteObservations, type QuoteObservation } from './lib/pricePolicy'
import { investAuth } from './lib/auth'
import { updateDividendAnnouncements } from './lib/dividendAnnouncements'

// ── Types ──────────────────────────────────────────────────────

export type PriceMap = Record<string, number | null>

export interface PriceUpdateOptions {
    onSnapshot?: (result: AutoSnapshotResult) => void
}

interface PriceContextValue {
    /** 所有已知股票現價，null = 無資料 */
    prices: PriceMap
    /** 最後更新時間（zh-TW 字串），空字串表示尚未更新 */
    lastUpdated: string
    /** 是否正在拉取報價 */
    priceLoading: boolean
    priceErrors: Record<string, string>
    quotes: QuoteObservations
    getCachedQuote: (code: string) => QuoteObservation | undefined
    ensurePrices: (codes: string[]) => Promise<PriceMap>
    refreshError: string
    /**
     * 全系統更新，codes 只補入尚未儲存的畫面代號，不限制更新範圍。
     * - 呼叫 Fugle API
     * - merge 寫入 Firebase settings/lastPrices
     * - 更新全域 prices state
     * @returns 本次取得的 quotes（供呼叫端同步使用，不需等 state 更新）
     */
    updatePrices: (codes: string[], options?: PriceUpdateOptions) => Promise<PriceMap>
    /**
     * 從 Firebase lastPrices 快取初始化（不打 Fugle API）。
     * 各頁面 load() 讀完 Firebase 後呼叫此方法。
     */
    loadCachedPrices: (savedPrices: Record<string, unknown>, savedAt: string) => void
}

// ── Context ────────────────────────────────────────────────────

const PriceContext = createContext<PriceContextValue | null>(null)

// ── Provider ───────────────────────────────────────────────────

export function PriceProvider({ children }: { children: ReactNode }) {
    const [prices, setPrices] = useState<PriceMap>({})
    const [lastUpdated, setLastUpdated] = useState('')
    const [priceLoading, setPriceLoading] = useState(false)
    const [priceErrors, setPriceErrors] = useState<Record<string, string>>({})
    const [quotes, setQuotes] = useState<QuoteObservations>({})
    const [refreshError, setRefreshError] = useState('')
    const sharedRefresh = useRef<{ user: typeof investAuth.currentUser; run: ReturnType<typeof createPriceRefreshCoordinator<Promise<AutoSnapshotResult | undefined>>> } | null>(null)
    const cacheRef = useRef<SavedPrices>({})
    const requestClock = useRef(0)

    const loadCachedPrices = useCallback((savedPrices: Record<string, unknown>, savedAt: string) => {
        const incoming = savedPrices as SavedPrices
        const previous = cacheRef.current
        const merged = mergeQuoteObservations(previous, incoming._quotes || {})
        for (const [code, value] of Object.entries(incoming)) {
            if (!code.startsWith('_') && !merged._quotes?.[code] && typeof value === 'number' && value > 0) merged[code] = value
        }
        cacheRef.current = merged
        const parsed: PriceMap = {}
        for (const [code, value] of Object.entries(merged)) {
            if (code.startsWith('_') || typeof value !== 'number') continue
            parsed[code] = merged._quotes?.[code]?.status === 'failed' || merged._quotes?.[code]?.status === 'stale' ? null : value
        }
        for (const [code, quote] of Object.entries(merged._quotes || {})) {
            if (quote.status !== 'success') parsed[code] = null
        }
        setPrices(parsed)
        setQuotes(merged._quotes || {})
        setPriceErrors(Object.fromEntries(Object.entries(merged._quotes || {})
            .filter(([, quote]) => quote.status !== 'success')
            .map(([code, quote]) => [code, quote.error || (quote.status === 'stale' ? '來源報價較舊，請重新更新' : '暫無有效報價')])))
        const updatedAt = merged._updatedAt || savedAt
        // This is a fetch timestamp, not a claim that all markets have today's closing price.
        const stamp = new Date(updatedAt)
        setLastUpdated(Number.isFinite(stamp.getTime()) ? stamp.toLocaleString('zh-TW') : updatedAt)

    }, [])

    // 跨分頁／跨裝置同步 settings/lastPrices；切換帳號時清除上一位使用者的報價。
    useEffect(() => {
        let priceUnsub: Unsubscribe | null = null
        const authUnsub = investAuth.onAuthStateChanged(user => {
            priceUnsub?.()
            cacheRef.current = {}
            sharedRefresh.current = null
            setPriceLoading(false)
            setPrices({})
            setPriceErrors({})
            setQuotes({})
            setRefreshError('')
            setLastUpdated('')
            if (!user) return
            priceUnsub = onSnapshot(userDocNested(investDB, 'settings', 'lastPrices'), snapshot => {
                if (investAuth.currentUser !== user || !snapshot.exists()) return
                const data = snapshot.data()
                loadCachedPrices(data, typeof data._updatedAt === 'string' ? data._updatedAt : '')
            }, error => console.error('[PriceContext] price sync error:', error))
        })
        return () => {
            authUnsub()
            priceUnsub?.()
        }
    }, [loadCachedPrices])

    const fetchAndStorePrices = useCallback(async (codes: string[], mode: 'global' | 'direct' = 'global'): Promise<QuoteRefreshResult<Promise<AutoSnapshotResult | undefined>>> => {
        if (codes.length === 0) return { prices: {} }
        const session = captureUserSession()
        const priceRef = session.doc(investDB, 'settings', 'lastPrices')
        requestClock.current = Math.max(Date.now(), requestClock.current + 1)
        const requestedAt = new Date(requestClock.current).toISOString()
        try {
            let preciseCodes: string[] = []
            if (mode === 'global' && isFubonSnapshotEnabled()) {
                try {
                    preciseCodes = await loadHoldingQuoteCodes()
                    session.assertActive()
                } catch { /* Market reference prices remain usable; verified auto snapshot stays blocked. */ }
            }
            const orderedCodes = [...new Set(codes)].sort((a, b) => Number(cacheRef.current._quotes?.[b]?.status === 'failed') - Number(cacheRef.current._quotes?.[a]?.status === 'failed'))
            const quotes = await getSharedQuoteObservations(orderedCodes, requestedAt, mode, preciseCodes)
            session.assertActive()
            const saved = await runTransaction(investDB, async transaction => {
                const snapshot = await transaction.get(priceRef)
                session.assertActive()
                const merged = mergeQuoteObservations(snapshot.exists() ? snapshot.data() as SavedPrices : {}, quotes)
                transaction.set(priceRef, merged)
                return merged
            })
            session.assertActive()
            loadCachedPrices(saved, saved._updatedAt || '')
            // Read the committed values, not a late response that the transaction rejected.
            const result: PriceMap = Object.fromEntries(codes.map(code => {
                const quote = cacheRef.current._quotes?.[code]
                return [code, quote?.status === 'success' ? quote.price : null]
            }))
            // Start under the captured account, but never hold quotes behind optional work.
            const detail = mode === 'global' ? maybeAutoSnapshotToday({ overwrite: true, trigger: 'price-update' })
                .then(snapshotResult => { session.assertActive(); return snapshotResult })
                .catch(error => { console.error('[PriceContext] auto snapshot error:', error); return undefined }) : undefined
            return { prices: result, detail }
        } catch (err) {
            console.error('[PriceContext] updatePrices error:', err)
            throw err
        }
    }, [loadCachedPrices])

    const updatePrices = useCallback(async (codes: string[], options?: PriceUpdateOptions): Promise<PriceMap> => {
        const session = captureUserSession()
        const user = investAuth.currentUser
        if (!sharedRefresh.current || sharedRefresh.current.user !== user) {
            sharedRefresh.current = { user, run: createPriceRefreshCoordinator(async () => {
                const codes = await loadGlobalQuoteCodes()
                session.assertActive()
                return codes
            }, async codes => {
                session.assertActive()
                return fetchAndStorePrices(codes)
            }) }
        }
        setPriceLoading(true)
        setRefreshError('')
        try {
            const result = await sharedRefresh.current.run(codes)
            session.assertActive()
            // User-triggered global refresh also checks public dividends; quotes never wait for it.
            // This task has daily client/server cooldowns and cannot write cash or inventory.
            void updateDividendAnnouncements(session).catch(() => {})
            if (result.detail) void result.detail.then(detail => {
                session.assertActive()
                if (detail) options?.onSnapshot?.(detail)
            }).catch(() => {})
            return Object.fromEntries(Object.keys(result.prices).map(code => {
                const quote = cacheRef.current._quotes?.[code]
                return [code, quote?.status === 'success' ? quote.price : null]
            }))
        } catch (error) {
            if (investAuth.currentUser === user) setRefreshError(error instanceof Error ? error.message : '全系統報價更新失敗')
            return {}
        } finally {
            if (investAuth.currentUser === user) setPriceLoading(false)
        }
    }, [fetchAndStorePrices])

    // New records/templates reuse shared prices; only missing codes need an API read.
    const ensurePrices = useCallback(async (codes: string[]): Promise<PriceMap> => {
        const session = captureUserSession()
        const missing = codes.filter(code => cacheRef.current._quotes?.[code]?.status !== 'success')
        if (missing.length) {
            if (isFubonSnapshotEnabled()) {
                try { await fetchAndStorePrices(missing, 'direct') }
                catch (error) { console.error('[PriceContext] direct quote error:', error) }
            } else await updatePrices(missing)
        }
        session.assertActive()
        return Object.fromEntries(codes.map(code => [code, cacheRef.current._quotes?.[code]?.status === 'success'
            ? cacheRef.current._quotes[code].price : null]))
    }, [fetchAndStorePrices, updatePrices])
    const getCachedQuote = useCallback((code: string) => cacheRef.current._quotes?.[code], [])

    return (
        <PriceContext.Provider value={{ prices, quotes, getCachedQuote, lastUpdated, priceLoading, priceErrors, refreshError, updatePrices, ensurePrices, loadCachedPrices }}>
            {children}
        </PriceContext.Provider>
    )
}

export function PriceRefreshStatus() {
    const { priceLoading, refreshError } = usePrices()
    if (!priceLoading && !refreshError) return null
    return <div role={refreshError ? 'alert' : 'status'} style={{ padding: '4px 16px', fontSize: '12px', color: refreshError ? 'var(--c-danger)' : 'var(--c-muted)' }}>
        {refreshError || '報價更新中'}
    </div>
}

// ── Hook ───────────────────────────────────────────────────────

export function usePrices(): PriceContextValue {
    const ctx = useContext(PriceContext)
    if (!ctx) throw new Error('usePrices must be used within <PriceProvider>')
    return ctx
}
